import { empty } from '../utilities/typeGuards';
import {
  ArgumentType,
  IGenericArgumentType,
  IGenericVariadicType,
  IGenericSuffixType,
  ISuffixType,
  IVariadicType,
  IGenericBasicType,
  Type,
} from './types/types';
import { Token } from '../entities/token';
import { TokenType } from '../entities/tokentypes';
import { booleanType } from './types/primitives/boolean';
import { integerType, doubleType } from './types/primitives/scalar';
import { stringType } from './types/primitives/string';
import {
  CallKind,
  TypeKind,
  OperatorKind,
  BinaryConstructor,
  UnaryConstructor,
} from './types';
import { Operator } from './operator';

/**
 * This map token types to binary operator kinds
 */
export const binaryOperatorMap: Map<TokenType, OperatorKind> = new Map([
  [TokenType.minus, OperatorKind.subtract],
  [TokenType.multi, OperatorKind.multiply],
  [TokenType.div, OperatorKind.divide],
  [TokenType.plus, OperatorKind.plus],
  [TokenType.less, OperatorKind.lessThan],
  [TokenType.lessEqual, OperatorKind.lessThanEqual],
  [TokenType.greater, OperatorKind.greaterThan],
  [TokenType.greaterEqual, OperatorKind.greaterThanEqual],
  [TokenType.and, OperatorKind.and],
  [TokenType.or, OperatorKind.or],
  [TokenType.equal, OperatorKind.equal],
  [TokenType.notEqual, OperatorKind.notEqual],
]);

/**
 * This maps tokens types to unary operator kinds
 */
export const unaryOperatorMap: Map<TokenType, OperatorKind> = new Map([
  [TokenType.not, OperatorKind.not],
  [TokenType.defined, OperatorKind.defined],
  [TokenType.minus, OperatorKind.negate],
  [TokenType.plus, OperatorKind.negate],
]);

/**
 * Retrieve the type of the follow token
 * @param token token to retreive
 */
export const tokenTrackedType = (token: Token): Maybe<Type> => {
  // check literals and other tokens
  switch (token.type) {
    case TokenType.true:
    case TokenType.false:
      return booleanType;
    case TokenType.integer:
      return integerType;
    case TokenType.double:
      return doubleType;
    case TokenType.string:
    case TokenType.fileIdentifier:
      return stringType;
    default:
      // if not a literally we need to lookup tracker
      const { tracker } = token;
      if (empty(tracker)) {
        return undefined;
      }

      return tracker.getType({ uri: token.uri, range: token });
  }
};

/**
 * check if the target call type is compatable with real call type
 * @param queryCallType real call type
 * @param targetCallType query call type
 */
export const isCorrectCallType = (
  queryCallType: CallKind,
  targetCallType: CallKind,
): boolean => {
  switch (queryCallType) {
    case CallKind.optionalCall:
      return (
        targetCallType === CallKind.get ||
        targetCallType === CallKind.call ||
        targetCallType === CallKind.optionalCall
      );
    case CallKind.get:
    case CallKind.set:
    case CallKind.call:
      return targetCallType === queryCallType;
  }
};

/**
 * check to see type is a sub type of target type
 * @param queryType query type
 * @param targetType target type
 */
export const isSubType = (queryType: Type, targetType: Type): boolean => {
  if (queryType.kind === TypeKind.basic && targetType.kind === TypeKind.basic) {
    return moveUpSuperTypes(queryType, false, currentType => {
      if (currentType === targetType) {
        return true;
      }

      return undefined;
    });
  }

  return queryType === targetType;
};

/**
 * Does the given type have the requested operator
 * @param type type
 * @param operator operator
 */
export const hasOperator = (
  type: Type,
  operator: OperatorKind,
): Maybe<Operator[]> => {
  if (type.kind === TypeKind.basic) {
    return moveUpSuperTypes(type, undefined, currentType => {
      const definedOperators = currentType.operators.get(operator);

      if (definedOperators) {
        return definedOperators;
      }

      return undefined;
    });
  }

  return undefined;
};

/**
 * Does the given type have the requested suffix
 * @param type type
 * @param suffix suffix string
 */
export const hasSuffix = (type: Type, suffix: string): boolean => {
  if (type.kind === TypeKind.basic) {
    return moveUpSuperTypes(type, false, currentType => {
      if (currentType.suffixes.has(suffix)) {
        return true;
      }

      return undefined;
    });
  }

  return false;
};

/**
 * Get the provided suffix from the type if it exists
 * @param type type
 * @param suffix suffix string
 */
export const getSuffix = (type: Type, suffix: string): Maybe<ISuffixType> => {
  if (type.kind === TypeKind.basic) {
    return moveUpSuperTypes(type, undefined, currentType => {
      return currentType.suffixes.get(suffix);
    });
  }

  return undefined;
};

/**
 * Retrieve all suffixes from the given type
 * @param type type
 */
export const allSuffixes = (type: Type): ISuffixType[] => {
  const suffixes: Map<string, ISuffixType> = new Map();

  switch (type.kind) {
    // if basic type get all suffixes on type
    case TypeKind.basic:
      moveUpSuperTypes(type, false, currentType => {
        for (const [name, suffix] of currentType.suffixes) {
          if (!suffixes.has(name)) {
            suffixes.set(name, suffix);
          }
        }

        return undefined;
      });
      break;

    // TODO may move logic outside of this function if
    // a gettable suffix get all suffixes on return type
    case TypeKind.suffix:
      switch (type.callType) {
        case CallKind.get:
        case CallKind.set:
        case CallKind.optionalCall:
          moveUpSuperTypes(type.returns, false, currentType => {
            for (const [name, suffix] of currentType.suffixes) {
              if (!suffixes.has(name)) {
                suffixes.set(name, suffix);
              }
            }

            return undefined;
          });
          break;
        default:
          break;
      }
      break;
    default:
  }

  return Array.from(suffixes.values());
};

/**
 * Is the generic variadic type a full variadic type
 * @param type maybe full variadic type
 */
export const isFullVarType = (
  type: IGenericVariadicType,
): type is IVariadicType => {
  return isFullType(type.type);
};

/**
 * Is the generic arguemnt type a full argument type
 * @param type maybe full argument type
 */
export const isFullType = (
  type: IGenericArgumentType,
): type is ArgumentType => {
  return type.fullType;
};

/**
 * Add type to prototype chain
 * @param type type to add prototype
 * @param prototype prototype
 */
export const addPrototype = <T extends IGenericBasicType>(
  type: T,
  prototype: T,
): void => {
  type.superType = prototype;
};

/**
 * Add operator to type
 * @param type type to add operator
 * @param operators operators
 */
export const addOperators = <T extends IGenericBasicType>(
  type: T,
  ...operators: (BinaryConstructor | UnaryConstructor)[]
): void => {
  for (const { operator, other, returnType } of operators) {
    const operators = type.operators.get(operator);

    if (!empty(operators)) {
      operators.push(new Operator(operator, returnType, other));
    } else {
      type.operators.set(operator, [new Operator(operator, returnType, other)]);
    }
  }
};

/**
 * Add suffixes to type
 * @param type type to add suffixes
 * @param suffixes suffixes
 */
export const addSuffixes = <
  T extends IGenericBasicType,
  S extends IGenericSuffixType
>(
  type: T,
  ...suffixes: S[]
): void => {
  for (const suffix of suffixes) {
    if (type.suffixes.has(suffix.name)) {
      throw new Error(`duplicate suffix ${suffix.name} added to type`);
    }

    type.suffixes.set(suffix.name, suffix);
  }
};

/**
 * Helper function to move up super type chain
 * @param type type to query
 * @param nullValue null if function does not return
 * @param func query function
 */
const moveUpSuperTypes = <T>(
  type: ArgumentType,
  nullValue: T,
  func: (currentType: ArgumentType) => Maybe<T>,
): T => {
  let currentType = type;
  while (true) {
    const result = func(currentType);
    if (!empty(result)) {
      return result;
    }

    if (empty(currentType.superType)) {
      return nullValue;
    }
    currentType = currentType.superType;
  }
};