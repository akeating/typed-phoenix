# typed-phoenix#

Typescript support for v1.2.0 of [phoenixframework]( https://github.com/phoenixframework/phoenix)

`lib/phoenix.ts` a typescript version of [phoenix.js]( https://github.com/phoenixframework/phoenix/blob/master/web/static/js/phoenix.js)

`lib/phoenix.js` a _generated_ es5 version of ^

`lib/phoenix.d.ts` the _generated_ typescript definitions for ^^

## Why? ##
phoenixframework does not come with typescript definitions which is a minor pain when using it in a Typescript project. Additionally, Typescript definition files that are rolled-by-hand are time consuming to build; I'd rather rewrite the original in Typescript and generate the defintion.

## Using `typed-phoenix`##

#### You can just use the definition ####
```
npm install --save-exact phoenix@1.2.0
typings install --save github:akeating/typed-phoenix#21741fece680122275172c87d22d6cff84a5f188
```
Modify your imports to read, e.g.
```
import { Socket, SocketOptions, Channel } from 'phoenix';
```


#### -or- use the Typescript version in this repo ####
```
npm uninstall phoenix
npm install --save github:akeating/typed-phoenix#21741fece680122275172c87d22d6cff84a5f188
```
Modify your imports to read, e.g.
```
import { Socket, SocketOptions, Channel } from 'typed-phoenix';
```
