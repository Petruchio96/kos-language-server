import { createStructureType, createSetSuffixType } from '../../ksType';
import { IArgumentType } from '../../types';
import { addPrototype, addSuffixes } from '../../../typeUitlities';
import { userDelegateType } from '../../userDelegate';
import { labelType } from './label';
import { booleanType } from '../../primitives/boolean';

export const textFieldType: IArgumentType = createStructureType('textField');
addPrototype(textFieldType, labelType);

addSuffixes(
  textFieldType,
  createSetSuffixType('changed', booleanType),
  createSetSuffixType('confirmed', booleanType),
  createSetSuffixType('onChange', userDelegateType),
  createSetSuffixType('onConfirm', userDelegateType),
);