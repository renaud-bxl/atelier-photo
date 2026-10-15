import { jsxDEV as original, Fragment } from '../node_modules/react/jsx-dev-runtime.js';
import { localizeProps } from './i18n.js';
export { Fragment };
export const jsxDEV=(type,props,...rest)=>original(type,localizeProps(props),...rest);
