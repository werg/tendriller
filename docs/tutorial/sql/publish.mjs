import { publishPage } from '../publish.mjs';
import { project, readPrivate, savePrivate } from './local.mjs';
console.log(JSON.stringify(await publishPage({ root: new URL('./page/', import.meta.url), projectState: project, read: readPrivate, save: savePrivate }), null, 2));
