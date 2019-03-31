import { IInst, IScript, RunInstType, SyntaxKind } from '../parser/types';
import { Range, Position, Location } from 'vscode-languageserver';

export class Script implements IScript {
  constructor(
    public readonly uri: string,
    public readonly insts: IInst[],
    public readonly runInsts: RunInstType[],
    public lazyGlobal = true) { }

  public get start(): Position {
    return this.insts[0].start;
  }

  public get end(): Position {
    return this.insts[this.insts.length - 1].end;
  }

  public get ranges(): Range[] {
    return [...this.insts];
  }

  toLocation(): Location {
    return { uri: this.uri, range: { start: this.start, end: this.end } };
  }

  public get tag(): SyntaxKind.script {
    return SyntaxKind.script;
  }
}