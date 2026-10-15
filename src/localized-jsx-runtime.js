import { jsx as originalJSX, jsxs as originalJSXS, Fragment } from '../node_modules/react/jsx-runtime.js';
import { localizeProps } from './i18n.js';
export { Fragment };
export const jsx=(type,props,key)=>originalJSX(type,localizeProps(props),key);
export const jsxs=(type,props,key)=>originalJSXS(type,localizeProps(props),key);
