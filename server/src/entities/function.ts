import { ScopeType } from '../parser/types';
import { IToken } from './types';
import { KsParameter } from './parameters';
import { EntityState } from '../analysis/types';

export class KsFunction {
  public readonly requiredParameters: number;

  constructor(
    public readonly scope: ScopeType,
    public readonly name: IToken,
    public readonly parameters: KsParameter[],
    public readonly returnValue: boolean,
    public state: EntityState,
  ) {
    this.requiredParameters = parameters
      .filter(parameter => !parameter.defaulted)
      .length;
  }

  get tag(): 'function' {
    return 'function';
  }
}