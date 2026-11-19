/* HQ model parse worker — loads the same parser as the main thread. */
"use strict";
importScripts("hq-model-view.js");

self.onmessage = function (e) {
  const data = e.data || {};
  const id = data.id;
  const name = data.name;
  const buffer = data.buffer;
  const opts = data.opts;
  try {
    if (!self.HQModel || typeof self.HQModel.parse !== "function") {
      throw new Error("HQModel indisponible dans le worker.");
    }
    const model = self.HQModel.parse(name, buffer, opts);
    const xfer = [];
    if (model.positions && model.positions.buffer) xfer.push(model.positions.buffer);
    if (model.normals && model.normals.buffer) xfer.push(model.normals.buffer);
    if (model.colors && model.colors.buffer) xfer.push(model.colors.buffer);
    self.postMessage({ id, ok: true, model }, xfer);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      message: err && err.message ? err.message : String(err),
    });
  }
};