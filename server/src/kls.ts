import {
  DiagnosticSeverity,
  Position,
  Location,
  Diagnostic,
  Range,
  Connection,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  InitializedParams,
  DidChangeConfigurationNotification,
  DidChangeConfigurationParams,
  CompletionParams,
  CompletionItem,
  TextDocumentPositionParams,
  RenameParams,
  WorkspaceEdit,
  TextEdit,
  DocumentHighlight,
  ReferenceParams,
  ParameterInformation,
  SignatureInformation,
  SignatureHelp,
  DocumentSymbolParams,
  SymbolInformation,
  TextDocument,
  FoldingRangeParams,
  FoldingRange,
} from 'vscode-languageserver';
import {
  IDocumentInfo,
  IDiagnosticUri,
  ValidateResult,
  KLSConfiguration,
  ClientConfiguration,
  LoadedDocuments,
} from './types';
import { performance, PerformanceObserver } from 'perf_hooks';
import { Parser } from './parser/parser';
import { PreResolver } from './analysis/preResolver';
import { Scanner } from './scanner/scanner';
import { Resolver } from './analysis/resolver';
import { IParseError, ScriptResult, RunStmtType } from './parser/types';
import {
  KsSymbol,
  KsSymbolKind,
  SymbolTracker,
  KsBaseSymbol,
  TrackerKind,
} from './analysis/types';
import { mockLogger, mockTracer, logException } from './utilities/logger';
import { empty } from './utilities/typeGuards';
import { ScriptFind } from './parser/scriptFind';
import * as Expr from './parser/expr';
import * as Stmt from './parser/stmt';
import * as SuffixTerm from './parser/suffixTerm';
import { runPath } from './utilities/pathResolver';
import {
  standardLibraryBuilder,
  bodyLibraryBuilder,
} from './analysis/standardLibrary';
import { builtIn, serverName, keywordCompletions } from './utilities/constants';
import { SymbolTableBuilder } from './analysis/symbolTableBuilder';
import { SymbolTable } from './analysis/symbolTable';
import { TypeChecker } from './typeChecker/typeChecker';
import { Token } from './entities/token';
import { binarySearchIndex } from './utilities/positionUtils';
import { URI } from 'vscode-uri';
import { DocumentService } from './services/documentService';
import {
  defaultClientConfiguration,
  caseMapper,
  logMapper,
  suffixCompletionItems,
  symbolCompletionItems,
  defaultSignature,
  documentSymbols,
} from './utilities/serverUtils';
import {
  cleanDiagnostic,
  cleanRange,
  cleanPosition,
  cleanLocation,
} from './utilities/clean';
import { isValidIdentifier } from './entities/tokentypes';
import { tokenTrackedType } from './typeChecker/typeUitlities';
import { TypeKind } from './typeChecker/types';
import { DocumentLoader, Document } from './utilities/documentLoader';
import { FoldableService } from './services/foldableService';

export class KLS {
  /**
   * What is the workspace uri
   */
  public workspaceUri?: string;

  /**
   * The current loaded standard library
   */
  private standardLibrary: SymbolTable;

  /**
   * The current loaded celetrial body library
   */
  private bodyLibrary: SymbolTable;

  /**
   * The logger used by this and all dependencies
   */
  private readonly logger: ILogger;

  /**
   * The tracer used by this and all dependencies
   */
  private readonly tracer: ITracer;

  /**
   * Document information
   */
  private readonly documentInfos: Map<string, IDocumentInfo>;

  /**
   * Performance observer for tracking analysis speed
   */
  private readonly observer: PerformanceObserver;

  /**
   * Connection to the client
   */
  private readonly connection: Connection;

  /**
   * This server's configuration
   */
  private readonly configuration: KLSConfiguration;

  /**
   * The document service to store and manage documents
   */
  private readonly documentService: DocumentService;

  /**
   * A service to take document info and generate all foldable regions
   */
  private readonly foldableService: FoldableService;

  constructor(
    caseKind: CaseKind = CaseKind.camelcase,
    logger: ILogger = mockLogger,
    tracer: ITracer = mockTracer,
    connection: Connection,
    configuration: KLSConfiguration,
  ) {
    this.workspaceUri = undefined;
    this.logger = logger;
    this.tracer = tracer;
    this.documentInfos = new Map();
    this.configuration = configuration;
    this.connection = connection;
    this.documentService = new DocumentService(
      connection,
      new DocumentLoader(),
      logger,
    );
    this.foldableService = new FoldableService();

    this.standardLibrary = standardLibraryBuilder(caseKind);
    this.bodyLibrary = bodyLibraryBuilder(caseKind);

    this.observer = new PerformanceObserver(list => {
      this.logger.verbose('');
      this.logger.verbose('-------- Performance ---------');
      for (const entry of list.getEntries()) {
        this.logger.verbose(`${entry.name} took ${entry.duration} ms`);
      }
      this.logger.verbose('------------------------------');
    });
    this.observer.observe({ entryTypes: ['measure'], buffered: true });
  }

  /**
   * Start the language server listening to requests from the client
   */
  public listen(): void {
    this.connection.onInitialize(this.onInitialize.bind(this));
    this.connection.onInitialized(this.onInitialized.bind(this));
    this.connection.onDidChangeConfiguration(
      this.onDidChangeConfiguration.bind(this),
    );
    this.connection.onCompletion(this.onCompletion.bind(this));
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this));
    this.connection.onRenameRequest(this.onRenameRequest.bind(this));
    this.connection.onDocumentHighlight(this.onDocumentHighlight.bind(this));
    this.connection.onHover(this.onHover.bind(this));
    this.connection.onReferences(this.onReference.bind(this));
    this.connection.onSignatureHelp(this.onSignatureHelp.bind(this));
    this.connection.onDocumentSymbol(this.onDocumentSymbol.bind(this));
    this.connection.onDefinition(this.onDefinition.bind(this));
    this.connection.onFoldingRanges(this.onFoldingRange.bind(this));

    this.documentService.onChange(this.onChange.bind(this));

    this.connection.listen();
  }

  /**
   * Initialize the server from the client connection
   * @param params initialization parameters
   */
  private onInitialize(params: InitializeParams): InitializeResult {
    const { capabilities, rootPath, rootUri } = params;

    this.connection.console.log(
      `[KLS Server(${process.pid})] Started and initialize received.`,
    );

    // does the client support configurations
    this.configuration.clientCapability.hasConfiguration = !!(
      capabilities.workspace && !!capabilities.workspace.configuration
    );

    // does the client support workspace folders
    this.configuration.clientCapability.hasWorkspaceFolder = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );

    // get root path if it exists
    if (rootPath) {
      this.configuration.workspaceFolder = rootPath;
    }

    // get root uri if it exists
    if (rootUri) {
      this.setUri(rootUri);
      this.configuration.workspaceUri = rootUri;
    }

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,

        // Tell the client that the server supports code completion
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: [':', '(', ', '],
        },

        // Tell the client that the server support signiture help
        signatureHelpProvider: {
          triggerCharacters: ['(', ',', ', '],
        },

        // indicate other capabilities
        renameProvider: true,
        documentHighlightProvider: true,
        hoverProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        definitionProvider: true,
        foldingRangeProvider: true,
      },
    };
  }

  /**
   * Post initialization register additional hooks and retrieve client
   * configurations
   * @param _ initialized parameters
   */
  private async onInitialized(_: InitializedParams): Promise<void> {
    const { clientCapability } = this.configuration;

    // register for all configuration changes.
    if (clientCapability.hasConfiguration) {
      this.connection.client.register(DidChangeConfigurationNotification.type, {
        section: serverName,
      });
    }

    // register workspace changes
    if (clientCapability.hasWorkspaceFolder) {
      this.connection.workspace.onDidChangeWorkspaceFolders(_ => {
        // TODO dump all documents
        this.logger.log('Workspace folder change event received.');
      });
    }

    const clientConfig = await this.getDocumentSettings();
    this.updateServer(clientConfig);
  }

  /**
   * Update the server configuration when the client signals a change in it's configuration for
   * the kos-language-server
   * @param change The updated settings
   */
  private onDidChangeConfiguration(change: DidChangeConfigurationParams): void {
    const { clientCapability } = this.configuration;

    if (clientCapability.hasConfiguration) {
      if (change.settings && serverName in change.settings) {
        Object.assign(
          this.configuration.clientConfig,
          defaultClientConfiguration,
          change.settings[serverName],
        );
      }

      // update server on client config
      this.updateServer(this.configuration.clientConfig);
    }
  }

  /**
   * Respond to completion requests from the client. This handler currently provides
   * both symbol completion as well as suffix completion.
   * @param completion the parameters describing the completion request
   */
  private onCompletion(completion: CompletionParams): Maybe<CompletionItem[]> {
    const { context } = completion;

    try {
      // check if suffix completion
      if (!empty(context) && !empty(context.triggerCharacter)) {
        const { triggerCharacter } = context;

        if (triggerCharacter === ':') {
          return suffixCompletionItems(this, completion);
        }
      }

      // complete base symbols
      return symbolCompletionItems(
        this,
        completion,
        this.configuration.keywords,
      );

      // catch any errors
    } catch (err) {
      logException(this.logger, this.tracer, err, LogLevel.error);
      return undefined;
    }
  }

  /**
   * This handler provider completion item resolution capability. This provides
   * additional information for the currently completion item selection
   * @param completionItem the item to resolve further
   */
  private onCompletionResolve(completionItem: CompletionItem): CompletionItem {
    try {
      const token = completionItem.data as Maybe<Token>;

      if (!empty(token)) {
      }

      return completionItem;
    } catch (err) {
      logException(this.logger, this.tracer, err, LogLevel.error);
      return completionItem;
    }
  }

  /**
   * This handler provider rename capabilities. This allows a client to highlight
   * as symbol and provide a new name that will change for all known symbols
   * @param rename information describing what and where a rename should occur
   */
  private onRenameRequest(rename: RenameParams): Maybe<WorkspaceEdit> {
    const { newName, position, textDocument } = rename;
    const scanner = new Scanner(newName);
    const { tokens, scanErrors } = scanner.scanTokens();

    // check if rename is valid
    if (
      scanErrors.length > 0 ||
      tokens.length !== 1 ||
      !isValidIdentifier(tokens[0].type)
    ) {
      return undefined;
    }

    const locations = this.getUsageLocations(position, textDocument.uri);
    if (empty(locations)) {
      return undefined;
    }
    const changes: PropType<WorkspaceEdit, 'changes'> = {};

    for (const location of locations) {
      if (!changes.hasOwnProperty(location.uri)) {
        changes[location.uri] = [];
      }

      changes[location.uri].push(TextEdit.replace(location.range, newName));
    }

    return { changes };
  }

  /**
   * This handler provides highlight within a requested document. This allows the client
   * to highlight and symbol and other instances of that symbol to also highlight.
   * @param positionParams the position of the highlight request
   */
  private onDocumentHighlight(
    positionParams: TextDocumentPositionParams,
  ): DocumentHighlight[] {
    const { position } = positionParams;
    const { uri } = positionParams.textDocument;

    const locations = this.getFileUsageRanges(position, uri);
    return empty(locations)
      ? []
      : locations.map(range => ({ range: cleanRange(range) }));
  }

  /**
   * This handler provides on hover capability for symbols in a document. This allows additional
   * information to be displayed to the user about symbols throughout the document
   * @param positionParams the position of the hover request
   */
  private onHover(positionParams: TextDocumentPositionParams) {
    const { position } = positionParams;
    const { uri } = positionParams.textDocument;

    const token = this.getToken(position, uri);

    if (empty(token)) {
      return undefined;
    }

    const type = tokenTrackedType(token);

    const { tracker } = token;
    let label: string;
    let symbolKind: string;

    if (!empty(tracker)) {
      symbolKind = KsSymbolKind[tracker.declared.symbol.tag];

      label =
        tracker.kind === TrackerKind.basic
          ? tracker.declared.symbol.name.lexeme
          : tracker.declared.symbol.name;
    } else {
      symbolKind = 'literal';
      label = token.lexeme;
    }

    if (empty(type)) {
      return undefined;
    }

    return {
      contents: {
        // Note doesn't does do much other than format it as code
        // may look into adding type def syntax highlighting
        language: 'kos',
        value: `(${symbolKind}) ${label}: ${type.toTypeString()} `,
      },
      range: {
        start: cleanPosition(token.start),
        end: cleanPosition(token.end),
      },
    };
  }

  /**
   * This handler provides reference capabilities to symbols in a document. This allows a client
   * to identify all positions that a symbol is used in the document or attached documents
   * @param reference parameters describing the reference request
   */
  private onReference(reference: ReferenceParams): Maybe<Location[]> {
    const { position } = reference;
    const { uri } = reference.textDocument;

    const locations = this.getUsageLocations(position, uri);
    return locations && locations.map(loc => cleanLocation(loc));
  }

  /**
   * This handler provides signature help suffixes and function within the document. This
   * provides extra context to the client such as the current parameter
   * @param positionParams the position of the signature request
   */
  private onSignatureHelp(
    positionParams: TextDocumentPositionParams,
  ): SignatureHelp {
    const { position } = positionParams;
    const { uri } = positionParams.textDocument;

    const result = this.getFunctionAtPosition(position, uri);
    if (empty(result)) return defaultSignature();
    const { tracker, index } = result;

    let label =
      typeof tracker.declared.symbol.name === 'string'
        ? tracker.declared.symbol.name
        : tracker.declared.symbol.name.lexeme;

    const type = tracker.getType({
      uri,
      range: { start: position, end: position },
    });

    if (empty(type)) {
      return defaultSignature();
    }

    switch (type.kind) {
      case TypeKind.function:
      case TypeKind.suffix:
        let start = label.length + 1;
        const { params } = type;
        const paramInfos: ParameterInformation[] = [];

        // check if normal or variadic type
        if (Array.isArray(params)) {
          // generate normal labels
          if (params.length > 0) {
            const labels: string[] = [];
            for (let i = 0; i < params.length - 1; i += 1) {
              const paramLabel = `${params[i].toTypeString()}, `;
              paramInfos.push(
                ParameterInformation.create([
                  start,
                  start + paramLabel.length - 2,
                ]),
              );
              labels.push(paramLabel);
              start = start + paramLabel.length;
            }

            const paramLabel = `${params[params.length - 1].toTypeString()}`;
            paramInfos.push(
              ParameterInformation.create([start, start + paramLabel.length]),
            );
            labels.push(paramLabel);
            label = `${label}(${labels.join('')})`;
          }
        } else {
          // generate variadic labels
          const variadicLabel = params.toTypeString();
          paramInfos.push(
            ParameterInformation.create([start, start + variadicLabel.length]),
          );
          label = `${label}(${variadicLabel})`;
        }

        return {
          signatures: [
            SignatureInformation.create(label, undefined, ...paramInfos),
          ],
          activeParameter: index,
          activeSignature: null,
        };
      default:
        return defaultSignature();
    }
  }

  /**
   * This handler provides document symbol capabilities. This provides a list of all
   * symbols that are located within a given document
   * @param documentSymbol the document to provide symbols for
   */
  private onDocumentSymbol(
    documentSymbol: DocumentSymbolParams,
  ): Maybe<SymbolInformation[]> {
    return documentSymbols(this, documentSymbol);
  }

  /**
   * This handler provides go to definition capabilities. When a client requests a symbol
   * go to definition this provides the location if it exists
   * @param positionParams the position of the definition request
   */
  private onDefinition(
    positionParams: TextDocumentPositionParams,
  ): Maybe<Location> {
    const { position } = positionParams;
    const { uri } = positionParams.textDocument;

    const location = this.getDeclarationLocation(position, uri);
    return location && cleanLocation(location);
  }

  /**
   * This handler provide folding region capabilities. The client will ask for available folding
   * region in which this will respond with the ranges defined by #region and #endregion
   * @param foldingParams the document to preform folding analysis on
   */
  private onFoldingRange(foldingParams: FoldingRangeParams): FoldingRange[] {
    const { uri } = foldingParams.textDocument;
    const documentInfo = this.documentInfos.get(uri);

    if (empty(documentInfo)) {
      return [];
    }

    const { script, regions } = documentInfo;
    return this.foldableService.findRegions(script, regions);
  }

  /**
   * Respond to updates made to document by the client. This method
   * will parse and update the internal state of affects scripts
   * reporting errors to the client as they are discovered
   * @param document the updated document
   */
  private async onChange(document: Document) {
    try {
      const diagnosticResults = this.validateDocument(
        document.uri,
        document.text,
      );

      let total = 0;
      const diagnosticMap: Map<string, Diagnostic[]> = new Map();

      // retrieve diagnostics from analyzer
      for await (const diagnostics of diagnosticResults) {
        total += diagnostics.length;

        for (const diagnostic of diagnostics) {
          const uriDiagnostics = diagnosticMap.get(diagnostic.uri);
          if (empty(uriDiagnostics)) {
            diagnosticMap.set(diagnostic.uri, [cleanDiagnostic(diagnostic)]);
          } else {
            uriDiagnostics.push(cleanDiagnostic(diagnostic));
          }
        }
      }

      // send diagnostics to each document reported
      for (const [uri, diagnostics] of diagnosticMap.entries()) {
        this.connection.sendDiagnostics({
          uri,
          diagnostics,
        });
      }

      // if not problems found clear out diagnostics
      if (total === 0) {
        this.connection.sendDiagnostics({
          uri: document.uri,
          diagnostics: [],
        });
      }
    } catch (e) {
      // report any exceptions to the client
      this.connection.console.error('kos-language-server Error occurred:');
      if (e instanceof Error) {
        this.connection.console.error(e.message);

        if (!empty(e.stack)) {
          this.connection.console.error(e.stack);
        }
      } else {
        this.connection.console.error(JSON.stringify(e));
      }
    }
  }

  /**
   * Get document settings from the client. If the client does not support
   * have configurations then return the default configurations.
   */
  private getDocumentSettings(): Thenable<ClientConfiguration> {
    if (!this.configuration.clientCapability.hasConfiguration) {
      return Promise.resolve(defaultClientConfiguration);
    }

    return this.connection.workspace.getConfiguration({
      scopeUri: this.workspaceUri,
      section: serverName,
    });
  }

  /**
   * Update the servers configuration in reponse to a change in the client configuration
   * @param clientConfig client configuration
   */
  private updateServer(clientConfig: ClientConfiguration) {
    this.configuration.clientConfig = clientConfig;

    const casePreference = caseMapper(clientConfig.completionCase);
    const logPreference = logMapper(clientConfig.trace.server.level);

    this.setCase(casePreference);
    this.logger.level = logPreference;
  }

  /**
   * Set the volume 0 path for the analyzer
   * @param uri path of volume 0
   */
  private setUri(uri: string): void {
    const parsed = URI.parse(uri);

    this.documentService.setVolume0Uri(parsed);
    this.workspaceUri = uri;
  }

  /**
   * Set the case of the body library and standard library
   * @param caseKind case to set
   */
  public setCase(caseKind: CaseKind) {
    this.configuration.keywords = keywordCompletions(caseKind);
    this.standardLibrary = standardLibraryBuilder(caseKind);
    this.bodyLibrary = bodyLibraryBuilder(caseKind);
  }

  /**
   * Validate a document in asynchronous stages. This produces diagnostics about known errors or
   * potential problems in the provided script
   * @param uri uri of the document
   * @param text source text of the document
   * @param depth TODO remove: current depth of the document
   */
  public async *validateDocument(
    uri: string,
    text: string,
    depth: number = 0,
  ): AsyncIterableIterator<IDiagnosticUri[]> {
    for await (const result of this.validateDocument_(uri, text, depth)) {
      if (Array.isArray(result)) {
        yield result;
      }
    }
  }

  /**
   * Get the token at the provided position in the text document
   * @param pos position in the text document
   * @param uri uri of the text document
   */
  public getToken(pos: Position, uri: string): Maybe<Token> {
    const documentInfo = this.documentInfos.get(uri);
    if (empty(documentInfo)) {
      return undefined;
    }

    // try to find an symbol at the position
    const { script } = documentInfo;
    const finder = new ScriptFind();
    const result = finder.find(script, pos);

    return result && result.token;
  }

  /**
   * Get the declaration location for the token at the provided position
   * @param pos position in the document
   * @param uri uri of the document
   */
  public getDeclarationLocation(pos: Position, uri: string): Maybe<Location> {
    const documentInfo = this.documentInfos.get(uri);
    if (empty(documentInfo)) {
      return undefined;
    }

    // try to find an symbol at the position
    const { script } = documentInfo;
    const finder = new ScriptFind();
    const result = finder.find(script, pos);

    if (empty(result)) {
      return undefined;
    }

    // check if symbols exists
    const { tracker } = result.token;
    if (empty(tracker)) {
      return undefined;
    }

    const { declared } = tracker;

    // exit if undefined
    if (declared.uri === builtIn) {
      return undefined;
    }

    return typeof declared.symbol.name !== 'string'
      ? declared.symbol.name
      : undefined;
  }

  /**
   * Get all usage locations in all files
   * @param pos position in document
   * @param uri uri of document
   */
  public getUsageLocations(pos: Position, uri: string): Maybe<Location[]> {
    const documentInfo = this.documentInfos.get(uri);
    if (
      empty(documentInfo) ||
      empty(documentInfo.symbolTable) ||
      empty(documentInfo.script)
    ) {
      return undefined;
    }

    // try to find the symbol at the position
    const { symbolTable: symbolsTable, script } = documentInfo;
    const finder = new ScriptFind();
    const result = finder.find(script, pos);

    if (empty(result)) {
      return undefined;
    }

    // try to find the tracker at a given position
    const { token } = result;
    const tracker = symbolsTable.scopedNamedTracker(pos, token.lookup);
    if (empty(tracker)) {
      return undefined;
    }

    return tracker.usages
      .map(usage => usage as Location)
      .concat(tracker.declared.symbol.name)
      .filter(location => location.uri !== builtIn);
  }

  /**
   * Get all usage ranges in a provide file
   * @param pos position in document
   * @param uri uri of document
   */
  public getFileUsageRanges(pos: Position, uri: string): Maybe<Range[]> {
    const locations = this.getUsageLocations(pos, uri);
    if (empty(locations)) {
      return locations;
    }

    return locations.filter(loc => loc.uri === uri).map(loc => loc.range);
  }

  /**
   * Get all symbols in scope at a particulare location in the file
   * @param pos position in document
   * @param uri document uri
   */
  public getScopedSymbols(pos: Position, uri: string): KsBaseSymbol[] {
    const documentInfo = this.documentInfos.get(uri);

    if (!empty(documentInfo) && !empty(documentInfo.symbolTable)) {
      return documentInfo.symbolTable.scopedSymbols(pos);
    }

    return [];
  }

  /**
   * Get all symbols in a provided file
   * @param uri document uri
   */
  public getAllFileSymbols(uri: string): KsSymbol[] {
    const documentInfo = this.documentInfos.get(uri);

    if (!empty(documentInfo) && !empty(documentInfo.symbolTable)) {
      return documentInfo.symbolTable.fileSymbols();
    }

    return [];
  }

  /**
   * Get a function located at the current location
   * @param pos position in the document
   * @param uri document uri
   */
  public getFunctionAtPosition(
    pos: Position,
    uri: string,
  ): Maybe<{ tracker: SymbolTracker; index: number }> {
    // we need the document info to lookup a signature
    const documentInfo = this.documentInfos.get(uri);
    if (empty(documentInfo)) return undefined;

    const { script } = documentInfo;
    const finder = new ScriptFind();

    // attempt to find a token here get surround invalid Stmt context
    const outerResult = finder.find(script, pos, Expr.Suffix, Stmt.Invalid);
    const innerResult = finder.find(script, pos, SuffixTerm.Call);

    let index = 0;
    if (
      !empty(innerResult) &&
      !empty(innerResult.node) &&
      innerResult.node instanceof SuffixTerm.Call
    ) {
      index =
        innerResult.node.args.length > 0 ? innerResult.node.args.length - 1 : 0;
    }

    // currently we only support invalid statements for signature completion
    // we could possible support call expressions as well
    if (empty(outerResult) || empty(outerResult.node)) {
      return undefined;
    }

    // determine the identifier of the invalid statement and parameter index
    const { node } = outerResult;

    // check if suffix
    if (node instanceof Expr.Suffix) {
      const tracker = node.mostResolveTracker();

      if (empty(tracker)) {
        return undefined;
      }

      switch (tracker.declared.symbol.tag) {
        case KsSymbolKind.function:
        case KsSymbolKind.suffix:
          return {
            index,
            tracker,
          };
        default:
          return undefined;
      }
    }

    // check if invalid statment
    if (node instanceof Stmt.Invalid) {
      const { ranges } = node;
      const indices = binarySearchIndex(ranges, pos);
      const start = Array.isArray(indices) ? indices[0] : indices;

      for (let i = start; i >= 0; i -= 1) {
        const element = ranges[i];

        if (element instanceof Expr.Suffix) {
          const tracker = element.mostResolveTracker();

          if (!empty(tracker)) {
            switch (tracker.declared.symbol.tag) {
              case KsSymbolKind.function:
              case KsSymbolKind.suffix:
                return {
                  index,
                  tracker,
                };
              default:
                return undefined;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Main validation function for a document. Lexically and semantically understands a document.
   * Will additionally perform the same analysis on other run scripts found in this script
   * @param uri uri of the document
   * @param text source text of the document
   * @param depth TODO remove: current depth of the document
   */
  private async *validateDocument_(
    uri: string,
    text: string,
    depth: number,
  ): AsyncIterableIterator<ValidateResult> {
    if (depth > 10) {
      return { diagnostics: [] };
    }

    const {
      script,
      regions,
      parseErrors,
      scanErrors,
    } = await this.parseDocument(uri, text);
    const symbolTables: SymbolTable[] = [];

    const scanDiagnostics = scanErrors.map(scanError =>
      addDiagnosticsUri(scanError, uri),
    );
    const parserDiagnostics =
      parseErrors.length === 0
        ? []
        : parseErrors
            .map(error => error.inner.concat(error))
            .reduce((acc, current) => acc.concat(current))
            .map(error => parseToDiagnostics(error, uri));

    yield scanDiagnostics.concat(parserDiagnostics);

    // if any run statement exist get uri then load
    if (script.runStmts.length > 0 && this.documentService.ready) {
      const { documents, diagnostics } = await this.loadDocuments(
        uri,
        script.runStmts,
      );

      yield diagnostics.map(error => addDiagnosticsUri(error, uri));

      // for each document run validate and yield any results
      for (const document of documents) {
        const cached = this.documentInfos.get(document.uri);

        if (empty(cached)) {
          for await (const result of this.validateDocument_(
            document.uri,
            document.getText(),
            depth + 1,
          )) {
            if (Array.isArray(result)) {
              yield result;
            } else {
              symbolTables.push(result);
            }
          }
        } else {
          yield cached.diagnostics;
          yield cached.symbolTable;
        }
      }
    }

    this.logger.verbose('');
    this.logger.verbose('-------------Semantic Analysis------------');

    // generate a scope manager for resolving
    const symbolTableBuilder = new SymbolTableBuilder(uri, this.logger);

    // add child scopes
    for (const symbolTable of symbolTables) {
      symbolTableBuilder.linkDependency(symbolTable);
    }

    // add standard library
    symbolTableBuilder.linkDependency(this.standardLibrary);
    symbolTableBuilder.linkDependency(this.activeBodyLibrary());

    // generate resolvers
    const preResolver = new PreResolver(
      script,
      symbolTableBuilder,
      this.logger,
      this.tracer,
    );
    const resolver = new Resolver(
      script,
      symbolTableBuilder,
      this.logger,
      this.tracer,
    );

    // traverse the ast to find functions to pre populate symbol table
    performance.mark('pre-resolver-start');
    const preDiagnostics = preResolver
      .resolve()
      .map(error => addDiagnosticsUri(error, uri));

    yield preDiagnostics;
    performance.mark('pre-resolver-end');

    // traverse the ast again to resolve the remaining symbols
    performance.mark('resolver-start');
    const resolverDiagnostics = resolver
      .resolve()
      .map(error => addDiagnosticsUri(error, uri));

    yield resolverDiagnostics;

    // find scopes were symbols were never used
    const unusedDiagnostics = symbolTableBuilder
      .findUnused()
      .map(error => addDiagnosticsUri(error, uri));

    yield unusedDiagnostics;
    performance.mark('resolver-end');

    const oldDocumentInfo = this.documentInfos.get(uri);

    // build the final symbol table
    const symbolTable = symbolTableBuilder.build(
      oldDocumentInfo && oldDocumentInfo.symbolTable,
    );

    // perform type checking
    const typeChecker = new TypeChecker(script, this.logger, this.tracer);

    performance.mark('type-checking-start');

    const typeDiagnostics = typeChecker
      .check()
      .map(error => addDiagnosticsUri(error, uri));

    // yield typeDiagnostics;
    performance.mark('type-checking-end');

    // measure performance
    performance.measure(
      'Pre Resolver',
      'pre-resolver-start',
      'pre-resolver-end',
    );
    performance.measure('Resolver', 'resolver-start', 'resolver-end');
    performance.measure(
      'Type Checking',
      'type-checking-start',
      'type-checking-end',
    );

    // make sure to delete references so scope manager can be gc'ed
    let documentInfo: Maybe<IDocumentInfo> = this.documentInfos.get(uri);
    if (!empty(documentInfo)) {
      documentInfo.symbolTable.removeSelf();
      documentInfo = undefined;
    }

    this.documentInfos.set(uri, {
      script,
      regions,
      symbolTable,
      diagnostics: scanDiagnostics.concat(
        parserDiagnostics,
        preDiagnostics,
        resolverDiagnostics,
        typeDiagnostics,
      ),
    });

    this.logger.verbose('--------------------------------------');
    performance.clearMarks();

    yield symbolTable;
  }

  /**
   * Generate a ast from the provided source text
   * @param uri uri to document
   * @param text source text of document
   */
  private async parseDocument(
    uri: string,
    text: string,
  ): Promise<ScriptResult> {
    this.logger.verbose('');
    this.logger.verbose('-------------Lexical Analysis------------');

    performance.mark('scanner-start');
    const scanner = new Scanner(text, uri, this.logger, this.tracer);
    const { tokens, scanErrors, regions } = scanner.scanTokens();
    performance.mark('scanner-end');

    // if scanner found errors report those immediately
    if (scanErrors.length > 0) {
      this.logger.warn(`Scanning encountered ${scanErrors.length} Errors.`);
    }

    performance.mark('parser-start');
    const parser = new Parser(uri, tokens, this.logger, this.tracer);
    const result = parser.parse();
    performance.mark('parser-end');

    // measure performance
    performance.measure('Scanner', 'scanner-start', 'scanner-end');
    performance.measure('Parser', 'parser-start', 'parser-end');
    performance.clearMarks();

    this.logger.verbose('--------------------------------------');

    return {
      scanErrors,
      regions,
      ...result,
    };
  }

  /**
   * Get all valid uris from the documents run statements
   * @param uri uri of the calling document
   * @param runStmts run statements in the document
   */
  private async loadDocuments(
    uri: string,
    runStmts: RunStmtType[],
  ): Promise<LoadedDocuments> {
    const documents: TextDocument[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const runStmt of runStmts) {
      // attempt to get a resolvable path from a run statement
      const path = runPath(runStmt);
      if (typeof path === 'string') {
        // attempt to load document
        const document = await this.documentService.loadDocument(
          runStmt.toLocation(uri),
          path,
        );

        if (!empty(document)) {
          // determine if document or diagnostic
          if (TextDocument.is(document)) {
            documents.push(document);
          } else {
            diagnostics.push(document);
          }
        }
        // was dynamically loaded path can't load
      } else {
        diagnostics.push(path);
      }
    }

    // generate uris then remove empty or preloaded documents
    return {
      documents,
      diagnostics,
    };
  }

  /**
   * Get the symbol table corresponding active set of celestial bodies for the user.
   * This allows for bodies other than that in stock ksp to be incorporated
   */
  private activeBodyLibrary(): SymbolTable {
    /** TODO actually load other bodies */
    return this.bodyLibrary;
  }
}

// convert parse error to diagnostic
const parseToDiagnostics = (
  error: IParseError,
  uri: string,
): IDiagnosticUri => {
  return {
    uri,
    severity: DiagnosticSeverity.Error,
    range: { start: error.start, end: error.end },
    message: error.message,
    source: 'kos-language-server',
  };
};

// convert resolver error to diagnostic
const addDiagnosticsUri = (error: Diagnostic, uri: string): IDiagnosticUri => {
  return { uri, ...error };
};
