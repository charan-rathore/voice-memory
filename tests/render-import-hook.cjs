const Module = require("node:module");
const load = Module._load;
globalThis.canvasImports = 0;
Module._load = function (request, ...rest) {
  if (request === "@napi-rs/canvas") globalThis.canvasImports++;
  return load.call(this, request, ...rest);
};
