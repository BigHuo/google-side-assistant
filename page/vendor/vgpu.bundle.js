// node_modules/@vgpu/core/dist/errors.js
var VGPUError = class extends Error {
  code;
  severity;
  fix;
  where;
  cause;
  detail;
  constructor(data) {
    super(data.message, { cause: data.cause });
    this.name = "VGPUError";
    this.code = data.code;
    this.severity = data.severity ?? "error";
    this.fix = data.fix;
    this.where = data.where;
    this.cause = data.cause;
    this.detail = data.detail;
  }
};
var ValidationError = class extends VGPUError {
  constructor(data) {
    super({ ...data, severity: "error" });
    this.name = "ValidationError";
  }
};
function unsupportedFeaturesError(missing) {
  return new VGPUError({
    code: "VGPU-FEATURE-UNSUPPORTED",
    message: `Adapter does not support requested feature(s): ${missing.map((name) => `"${name}"`).join(", ")}.`,
    fix: "Remove the unsupported name(s) from init({ requiredFeatures: [...] }) or run on an adapter that supports them; gate optional code paths on device.features after init.",
    where: "init"
  });
}
function validateRequiredFeatures(supported, required) {
  if (!supported)
    return;
  const missing = (required ?? []).filter((feature) => !supported.has(feature));
  if (missing.length)
    throw unsupportedFeaturesError(missing);
}

// node_modules/@vgpu/core/dist/gpu-constants.js
var fallbackUsage = {
  map_read: 1,
  map_write: 2,
  copy_src: 4,
  copy_dst: 8,
  index: 16,
  vertex: 32,
  uniform: 64,
  storage: 128,
  indirect: 256,
  query_resolve: 512
};
function bufferUsageFlags(usages) {
  const constants = globalThis.GPUBufferUsage;
  return usages.reduce((flags, usage) => flags | usageFlag(usage, constants), 0);
}
function usageFlag(usage, constants) {
  const key = usage.toUpperCase();
  return constants?.[key] ?? fallbackUsage[usage];
}
function mapReadMode() {
  return globalThis.GPUMapMode?.READ ?? 1;
}
var fallbackTextureUsage = {
  copy_src: 1,
  copy_dst: 2,
  texture_binding: 4,
  storage_binding: 8,
  render_attachment: 16
};
function textureUsageFlags(usages) {
  const constants = globalThis.GPUTextureUsage;
  return usages.reduce((flags, usage) => flags | textureUsageFlag(usage, constants), 0);
}
function textureUsageFlag(usage, constants) {
  const key = usage.toUpperCase();
  return constants?.[key] ?? fallbackTextureUsage[usage];
}

// node_modules/@vgpu/core/dist/mock-gpu-storage.js
function isMockGPUBuffer(buffer) {
  return "__vgpuMockBytes" in buffer;
}
function isMockGPUTexture(texture2) {
  return "__vgpuMockBytes" in texture2;
}

// node_modules/@vgpu/core/dist/resource-lifecycle.js
var nextResourceId = 1;
function createResourceIdentity(kind) {
  return Object.freeze({ kind, id: nextResourceId++ });
}
var DestroySignal = class {
  callbacks = /* @__PURE__ */ new Set();
  destroyed = false;
  onDestroy(resource, cb) {
    if (this.destroyed) {
      cb(resource);
      return () => void 0;
    }
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }
  emit(resource) {
    if (this.destroyed)
      return false;
    this.destroyed = true;
    const callbacks = [...this.callbacks];
    this.callbacks.clear();
    const errors = [];
    for (const cb of callbacks) {
      try {
        cb(resource);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw errors[0];
    return true;
  }
};

// node_modules/@vgpu/core/dist/buffer.js
var Buffer = class {
  device;
  gpu;
  options;
  ownership;
  destroySignal = new DestroySignal();
  identity = createResourceIdentity("buffer");
  destroyed = false;
  constructor(device, gpu, options, ownership = "owned") {
    this.device = device;
    this.gpu = gpu;
    this.options = options;
    this.ownership = ownership;
    Object.defineProperty(this, "assertUsable", { value: (where) => this.#assertUsable(where) });
  }
  get resourceIdentity() {
    return this.identity;
  }
  onDestroy(cb) {
    return this.destroySignal.onDestroy(this, cb);
  }
  #assertUsable(where = "Buffer") {
    if (this.destroyed) {
      throw new ValidationError({
        code: "VGPU-BUFFER-DISPOSED",
        message: "Buffer is destroyed.",
        where,
        fix: "Wrap or create a live GPUBuffer before using it."
      });
    }
    this.device.assertUsable(where);
  }
  write(data, offset = 0) {
    this.#assertUsable("Buffer.write");
    if (this.ownership === "external") {
      this.validateExternalOperation("write", offset, data.byteLength, "copy_dst");
    }
    try {
      this.device.queue.writeBuffer(this.gpu, offset, data);
    } catch (cause) {
      if (this.ownership !== "external")
        throw cause;
      throw externalBufferValidation("Buffer.write", "The external GPUBuffer rejected the write operation.", cause);
    }
  }
  async read(byteLength2, offset = 0) {
    this.#assertUsable("Buffer.read");
    if (this.ownership === "external")
      this.validateExternalOperation("read", offset, byteLength2, "copy_src");
    try {
      const result = await this.device.readback.read(this.gpu, byteLength2, offset);
      this.#assertUsable("Buffer.read");
      return result;
    } catch (cause) {
      if (cause instanceof ValidationError || this.ownership !== "external")
        throw cause;
      throw externalBufferValidation("Buffer.read", "The external GPUBuffer rejected the read operation.", cause);
    }
  }
  destroy() {
    if (this.destroyed)
      return;
    this.destroyed = true;
    this.destroySignal.emit(this);
    if (this.ownership === "owned" && !isMockGPUBuffer(this.gpu))
      this.gpu.destroy();
  }
  dispose() {
    this.destroy();
  }
  validateExternalOperation(operation, offset, byteLength2, requiredUsage) {
    const validRange = Number.isSafeInteger(offset) && offset >= 0 && offset % 4 === 0 && Number.isSafeInteger(byteLength2) && byteLength2 >= 0 && byteLength2 % 4 === 0 && offset <= this.options.size && byteLength2 <= this.options.size - offset;
    if (!validRange) {
      throw externalBufferValidation(`Buffer.${operation}`, "External buffer offsets and lengths must be non-negative, 4-byte aligned, and within the buffer size.");
    }
    if ((this.gpu.usage & bufferUsageFlags([requiredUsage])) === 0) {
      throw externalBufferValidation(`Buffer.${operation}`, `External buffer is missing ${requiredUsage.toUpperCase()} usage.`);
    }
  }
};
function externalBufferValidation(where, message, cause) {
  return new ValidationError({
    code: "VGPU-EXTERNAL-BUFFER-VALIDATION",
    message,
    where,
    cause,
    fix: "Use a buffer with the required usage flags and an aligned in-range operation."
  });
}

// node_modules/@vgpu/wgsl/dist/compile.js
function compile(wgsl) {
  if (hasTopLevelImport(wgsl))
    throw runtimeImportError();
  const sourceMap = { version: 1, mappings: [] };
  const ast = {
    version: 1,
    modules: [{ path: "<runtime>", text: wgsl }],
    diagnostics: [],
    sourceMap,
    cacheKey: cacheKey(wgsl)
  };
  return {
    kind: "wgsl",
    wgsl,
    source: { text: wgsl, path: "<runtime>", imports: [] },
    ast,
    sourceMap,
    diagnostics: [],
    cacheKey: ast.cacheKey,
    entryPoints: entryPoints(wgsl),
    stats: { lines: wgsl.split(/\r?\n/).length, bytes: new TextEncoder().encode(wgsl).byteLength, bindGroups: 0 }
  };
}
function cacheKey(wgsl) {
  let hash = 2166136261;
  for (let i = 0; i < wgsl.length; i++)
    hash = Math.imul(hash ^ wgsl.charCodeAt(i), 16777619);
  return { default: `vgpu-wgsl-1:${(hash >>> 0).toString(16).padStart(8, "0")}` };
}
function entryPoints(wgsl) {
  const names = [];
  const pattern = /@(vertex|fragment|compute)\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of wgsl.matchAll(pattern))
    names.push(match[2]);
  return names;
}
function hasTopLevelImport(wgsl) {
  const stripped = wgsl.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trimStart();
  return stripped.startsWith("import ") || stripped.startsWith("import{");
}
function runtimeImportError() {
  const error = new Error("Runtime WGSL strings cannot contain import statements. Use a build-time loader or @vgpu/wgsl/runtime.");
  error.name = "VGPUWGSLRuntimeImportError";
  error.code = "VGPU-WGSL-RUNTIME-IMPORT";
  error.severity = "error";
  error.source = "wgsl";
  return error;
}

// node_modules/@vgpu/wgsl/dist/runtime/wgsl-identifier-rules.js
var WGSL_SPEC_KEYWORDS = /* @__PURE__ */ new Set([
  "alias",
  "break",
  "case",
  "const",
  "const_assert",
  "continue",
  "continuing",
  "default",
  "diagnostic",
  "discard",
  "else",
  "enable",
  "false",
  "fn",
  "for",
  "if",
  "let",
  "loop",
  "override",
  "requires",
  "return",
  "struct",
  "switch",
  "true",
  "var",
  "while"
]);
var VGPU_MODULE_KEYWORDS = /* @__PURE__ */ new Set(["import", "export", "from", "as"]);
var WGSL_KEYWORDS = /* @__PURE__ */ new Set([...WGSL_SPEC_KEYWORDS, ...VGPU_MODULE_KEYWORDS]);
var WGSL_RESERVED_WORDS = /* @__PURE__ */ new Set([
  "NULL",
  "Self",
  "abstract",
  "active",
  "alignas",
  "alignof",
  "as",
  "asm",
  "asm_fragment",
  "async",
  "attribute",
  "auto",
  "await",
  "become",
  "cast",
  "catch",
  "class",
  "co_await",
  "co_return",
  "co_yield",
  "coherent",
  "column_major",
  "common",
  "compile",
  "compile_fragment",
  "concept",
  "const_cast",
  "consteval",
  "constexpr",
  "constinit",
  "crate",
  "debugger",
  "decltype",
  "delete",
  "demote",
  "demote_to_helper",
  "do",
  "dynamic_cast",
  "enum",
  "explicit",
  "export",
  "extends",
  "extern",
  "external",
  "fallthrough",
  "filter",
  "final",
  "finally",
  "friend",
  "from",
  "fxgroup",
  "get",
  "goto",
  "groupshared",
  "highp",
  "impl",
  "implements",
  "import",
  "inline",
  "instanceof",
  "interface",
  "layout",
  "lowp",
  "macro",
  "macro_rules",
  "match",
  "mediump",
  "meta",
  "mod",
  "module",
  "move",
  "mut",
  "mutable",
  "namespace",
  "new",
  "nil",
  "noexcept",
  "noinline",
  "nointerpolation",
  "non_coherent",
  "noncoherent",
  "noperspective",
  "null",
  "nullptr",
  "of",
  "operator",
  "package",
  "packoffset",
  "partition",
  "pass",
  "patch",
  "pixelfragment",
  "precise",
  "precision",
  "premerge",
  "priv",
  "protected",
  "pub",
  "public",
  "readonly",
  "ref",
  "regardless",
  "register",
  "reinterpret_cast",
  "require",
  "resource",
  "restrict",
  "self",
  "set",
  "shared",
  "sizeof",
  "smooth",
  "snorm",
  "static",
  "static_assert",
  "static_cast",
  "std",
  "subroutine",
  "super",
  "target",
  "template",
  "this",
  "thread_local",
  "throw",
  "trait",
  "try",
  "type",
  "typedef",
  "typeid",
  "typename",
  "typeof",
  "union",
  "unless",
  "unorm",
  "unsafe",
  "unsized",
  "use",
  "using",
  "varying",
  "virtual",
  "volatile",
  "wgsl",
  "where",
  "with",
  "writeonly",
  "yield"
]);
var WGSL_LEGACY_RESERVED_WORDS = /* @__PURE__ */ new Set(["binding_array"]);

// node_modules/@vgpu/core/dist/texture-read-selection.js
function textureMipExtent(texture2, mipLevel) {
  const scale = 2 ** mipLevel;
  return [
    Math.max(1, Math.floor(texture2.width / scale)),
    Math.max(1, Math.floor(texture2.height / scale)),
    texture2.dimension === "3d" ? Math.max(1, Math.floor(texture2.depthOrArrayLayers / scale)) : texture2.depthOrArrayLayers
  ];
}
function textureReadSelection(texture2, options, where) {
  const fail = (message) => {
    throw new ValidationError({
      code: "VGPU-CORE-TEXTURE-READ-INVALID",
      where,
      message,
      fix: 'Select an allocated mip and an in-bounds region on a single-sample texture with usage "copy_src".'
    });
  };
  if (!options || !Number.isSafeInteger(options.mipLevel) || options.mipLevel < 0 || options.mipLevel >= texture2.mipLevelCount)
    fail("mipLevel must select an allocated mip using a nonnegative safe integer.");
  if (texture2.sampleCount !== 1)
    fail("Texture readback requires sampleCount 1; resolve multisampled textures explicitly before reading.");
  if (!(texture2.usage & textureUsageFlags(["copy_src"])))
    fail('Texture readback requires explicit "copy_src" usage.');
  const extent = textureMipExtent(texture2, options.mipLevel);
  const origin = options.region === "all" ? [0, 0, 0] : options.region?.origin;
  const size = options.region === "all" ? extent : options.region?.size;
  if (!Array.isArray(origin) || origin.length !== 3 || !Array.isArray(size) || size.length !== 3)
    fail('region must be "all" or contain origin and size triples.');
  for (let i = 0; i < 3; i++) {
    const start = origin[i];
    const length = size[i];
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || start > extent[i] || length > extent[i] - start)
      fail(`Read region axis ${i} is outside mip ${options.mipLevel} extent [${extent}].`);
  }
  return { mipLevel: options.mipLevel, origin: [...origin], size: [...size], extent };
}
function validateReadAllocation(byteLength2, maxBufferSize, where) {
  const limit = Math.min(maxBufferSize ?? 4294967295, 4294967295);
  if (!Number.isSafeInteger(byteLength2) || byteLength2 <= 0 || byteLength2 > limit) {
    throw new ValidationError({
      code: "VGPU-CORE-TEXTURE-READ-INVALID",
      where,
      message: `Readback allocation of ${byteLength2} bytes exceeds the supported limit (${limit}).`,
      fix: "Read a smaller region or a higher mip level."
    });
  }
}

// node_modules/@vgpu/core/dist/readback.js
var stagingUsage = bufferUsageFlags(["copy_dst", "map_read"]);
var Readback = class {
  device;
  constructor(device) {
    this.device = device;
  }
  async read(source, byteLength2, offset) {
    if (isMockGPUBuffer(source)) {
      return source.__vgpuMockBytes.slice(offset, offset + byteLength2).buffer;
    }
    const staging = this.device.createBuffer({
      size: byteLength2,
      usage: stagingUsage
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, offset, staging, 0, byteLength2);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(mapReadMode());
      const copy = staging.getMappedRange().slice(0);
      unmapQuietly(staging);
      return copy;
    } finally {
      destroyQuietly(staging);
    }
  }
  async readTexture(texture2, options) {
    const formatInfo = textureReadbackFormat(texture2.format, "Readback.readTexture");
    const selection = textureReadSelection(texture2, options, "Readback.readTexture");
    const [width, height, depth] = selection.size;
    const bytesPerPixel = formatInfo.bytesPerPixel;
    const bytesPerRow = align(width * bytesPerPixel, 256);
    const byteLength2 = bytesPerRow * height * depth;
    validateReadAllocation(byteLength2, this.device.limits?.maxBufferSize, "Readback.readTexture");
    if (isMockGPUTexture(texture2)) {
      const stored = texture2.__vgpuMockMips?.[selection.mipLevel] ?? (selection.mipLevel === 0 ? texture2.__vgpuMockBytes : void 0);
      if (!stored)
        throw new Error("Mock texture has no storage for the selected mip.");
      return readMockTextureBytes(stored, selection, formatInfo);
    }
    const staging = this.device.createBuffer({ size: byteLength2, usage: stagingUsage });
    let pixels;
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: texture2, mipLevel: selection.mipLevel, origin: selection.origin }, { buffer: staging, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: depth });
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(mapReadMode());
      const padded = new Uint8Array(staging.getMappedRange());
      pixels = new Uint8Array(width * height * depth * bytesPerPixel);
      for (let y = 0; y < height * depth; y++) {
        const src = y * bytesPerRow;
        const dst = y * width * bytesPerPixel;
        pixels.set(padded.subarray(src, src + width * bytesPerPixel), dst);
      }
      unmapQuietly(staging);
    } finally {
      destroyQuietly(staging);
    }
    if (formatInfo.swizzle === "bgra-to-rgba")
      swizzleBgraToRgba(pixels);
    return pixels;
  }
  destroy() {
  }
};
function unmapQuietly(buffer) {
  try {
    buffer.unmap();
  } catch {
  }
}
function destroyQuietly(buffer) {
  try {
    buffer.destroy();
  } catch {
  }
}
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
var readbackFormats = {
  "r8unorm": { bytesPerPixel: 1, components: 1, componentType: "unorm8" },
  "rg8unorm": { bytesPerPixel: 2, components: 2, componentType: "unorm8" },
  "rgba8unorm": { bytesPerPixel: 4, components: 4, componentType: "unorm8" },
  "rgba8unorm-srgb": { bytesPerPixel: 4, components: 4, componentType: "unorm8" },
  "bgra8unorm": { bytesPerPixel: 4, components: 4, componentType: "unorm8", swizzle: "bgra-to-rgba" },
  "bgra8unorm-srgb": { bytesPerPixel: 4, components: 4, componentType: "unorm8", swizzle: "bgra-to-rgba" },
  "r16float": { bytesPerPixel: 2, components: 1, componentType: "float16" },
  "rg16float": { bytesPerPixel: 4, components: 2, componentType: "float16" },
  "rgba16float": { bytesPerPixel: 8, components: 4, componentType: "float16" },
  "r32float": { bytesPerPixel: 4, components: 1, componentType: "float32" },
  "rg32float": { bytesPerPixel: 8, components: 2, componentType: "float32" },
  "rgba32float": { bytesPerPixel: 16, components: 4, componentType: "float32" }
};
function textureReadbackFormat(format, where) {
  const info = readbackFormats[format];
  if (info)
    return info;
  throw new ValidationError({
    code: "VGPU-CORE-UNSUPPORTED-FORMAT",
    message: `Texture.read does not support format ${format}. Supported formats: ${Object.keys(readbackFormats).join(", ")}.`,
    where
  });
}
function decodeTextureFloats(bytes, format, where = "Texture.readFloats") {
  const info = textureReadbackFormat(format, where);
  const bytesPerComponent = info.bytesPerPixel / info.components;
  const count = Math.floor(bytes.byteLength / bytesPerComponent);
  const floats = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    if (info.componentType === "unorm8")
      floats[i] = view.getUint8(i) / 255;
    else if (info.componentType === "float16")
      floats[i] = halfToFloat(view.getUint16(i * 2, true));
    else
      floats[i] = view.getFloat32(i * 4, true);
  }
  return floats;
}
function halfToFloat(bits) {
  const sign = bits & 32768 ? -1 : 1;
  const exponent = bits >> 10 & 31;
  const mantissa = bits & 1023;
  if (exponent === 0)
    return sign * mantissa * 2 ** -24;
  if (exponent === 31)
    return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}
function readMockTextureBytes(stored, selection, info) {
  const { size: [width, height, depth], origin: [x, y, z], extent } = selection;
  const rowBytes = width * info.bytesPerPixel;
  const pixels = new Uint8Array(rowBytes * height * depth);
  for (let layer = 0; layer < depth; layer++)
    for (let row = 0; row < height; row++) {
      const src = (((z + layer) * extent[1] + y + row) * extent[0] + x) * info.bytesPerPixel;
      pixels.set(stored.subarray(src, src + rowBytes), (layer * height + row) * rowBytes);
    }
  if (info.swizzle === "bgra-to-rgba")
    swizzleBgraToRgba(pixels);
  return pixels;
}
function swizzleBgraToRgba(pixels) {
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i];
    pixels[i] = pixels[i + 2];
    pixels[i + 2] = b;
  }
}

// node_modules/@vgpu/core/dist/mock-gpu.js
function mockBufferDescriptor(size) {
  return { size, usage: bufferUsageFlags(["copy_src", "copy_dst"]) };
}

// node_modules/@vgpu/core/dist/queue.js
var Queue = class {
  gpu;
  guard;
  constructor(gpu, guard = () => void 0) {
    this.gpu = gpu;
    this.guard = guard;
  }
  writeBuffer(buffer, offset, data) {
    this.guard("Queue.writeBuffer");
    this.gpu.writeBuffer(buffer, offset, data);
  }
  async flush() {
    this.guard("Queue.flush");
    await this.gpu.onSubmittedWorkDone?.();
    this.guard("Queue.flush");
  }
};

// node_modules/@vgpu/core/dist/shader.js
var Shader = class {
  gpu;
  resolved;
  constructor(gpu, resolved) {
    this.gpu = gpu;
    this.resolved = resolved;
  }
  dispose() {
  }
  get kind() {
    return this.resolved.kind;
  }
  get source() {
    return this.resolved.source;
  }
  get code() {
    return this.resolved.wgsl;
  }
  get entryPoints() {
    return this.resolved.entryPoints;
  }
  get stats() {
    return this.resolved.stats;
  }
};

// node_modules/@vgpu/core/dist/texture-options.js
var USAGES = /* @__PURE__ */ new Set(["copy_src", "copy_dst", "texture_binding", "storage_binding", "render_attachment"]);
var STORAGE_FORMATS = /* @__PURE__ */ new Set([
  "rgba8unorm",
  "rgba8snorm",
  "rgba8uint",
  "rgba8sint",
  "rgba16float",
  "rgba16uint",
  "rgba16sint",
  "rgba32float",
  "rgba32uint",
  "rgba32sint",
  "r32float",
  "r32uint",
  "r32sint",
  "rg32float",
  "rg32uint",
  "rg32sint"
]);
var TIER1_STORAGE_FORMATS = /* @__PURE__ */ new Set([
  "r8unorm",
  "r8snorm",
  "r8uint",
  "r8sint",
  "rg8unorm",
  "rg8snorm",
  "rg8uint",
  "rg8sint",
  "r16uint",
  "r16sint",
  "r16float",
  "rg16uint",
  "rg16sint",
  "rg16float",
  "rgb10a2uint",
  "rgb10a2unorm",
  "rg11b10ufloat",
  "r16unorm",
  "r16snorm",
  "rg16unorm",
  "rg16snorm",
  "rgba16unorm",
  "rgba16snorm"
]);
function snapshotTextureOptions(opts) {
  return Object.freeze({
    ...opts,
    size: Object.freeze([...opts.size]),
    usage: Object.freeze([...opts.usage]),
    ...opts.viewFormats === void 0 ? {} : { viewFormats: Object.freeze([...opts.viewFormats]) }
  });
}
function textureExtent(opts) {
  return [opts.size[0], opts.kind === "1d" ? 1 : opts.size[1], opts.kind === "2d-array" ? opts.layers : opts.kind === "3d" ? opts.size[2] : 1];
}
function validateTextureOptions(opts, device) {
  const fail = (code, message, fix) => {
    throw new ValidationError({ code, message, fix, where: "Device.createTexture" });
  };
  if (!opts || !["1d", "2d", "3d", "2d-array"].includes(opts.kind)) {
    fail("VGPU-TEXTURE-KIND-REQUIRED", "Texture kind must be explicit.", 'Pass kind: "1d", "2d", "3d", or "2d-array".');
  }
  if ("dimension" in opts)
    fail("VGPU-TEXTURE-KIND-REQUIRED", "Texture dimension has been replaced by kind.", 'Use kind and, for "2d-array", a separate layers count.');
  const axes = opts.kind === "1d" ? 1 : opts.kind === "3d" ? 3 : 2;
  if (!Array.isArray(opts.size) || opts.size.length !== axes || !Array.from(opts.size).every(positiveInteger)) {
    fail("VGPU-TEXTURE-SIZE-REQUIRED", `Texture ${opts.kind} needs ${axes} positive integer spatial dimensions.`, "Pass size with exactly the spatial dimensions of kind; put array layers in layers.");
  }
  if (opts.kind === "2d-array" ? !positiveInteger(opts.layers) : opts.layers !== void 0) {
    fail("VGPU-TEXTURE-LAYERS-INVALID", "Only 2d-array textures take a positive integer layers count.", 'Use kind: "2d-array", size: [width, height], layers: count.');
  }
  if (!Array.isArray(opts.usage) || opts.usage.length === 0 || !Array.from(opts.usage).every((usage) => USAGES.has(usage))) {
    fail("VGPU-TEXTURE-USAGE-REQUIRED", "Texture usage must be a nonempty list of known capabilities.", 'Pass explicit usage, such as ["texture_binding", "copy_dst"]. No capabilities are added automatically.');
  }
  if (typeof opts.format !== "string" || !opts.format)
    fail("VGPU-TEXTURE-FORMAT-REQUIRED", "Texture format is required.", 'Pass an explicit GPUTextureFormat, such as "rgba16float".');
  const levels = opts.mipLevelCount ?? 1;
  const maxLevels = opts.kind === "1d" ? 1 : Math.floor(Math.log2(Math.max(...opts.size))) + 1;
  if (!positiveInteger(levels) || levels > maxLevels) {
    fail("VGPU-TEXTURE-MIPS-INVALID", `mipLevelCount must be between 1 and ${maxLevels}.`, "Omit mipLevelCount for the base level, or request a valid allocation count. Contents are not generated automatically.");
  }
  const samples = opts.sampleCount ?? 1;
  if (samples !== 1 && samples !== 4)
    fail("VGPU-TEXTURE-SAMPLES-INVALID", "sampleCount must be 1 or 4.", "Omit sampleCount for single-sample storage.");
  if (samples === 4 && (opts.kind !== "2d" || levels !== 1 || !opts.usage.includes("render_attachment") || opts.usage.includes("storage_binding"))) {
    fail("VGPU-TEXTURE-SAMPLES-INVALID", "MSAA requires a 2d render attachment with one mip and no storage_binding.", "Use a single-sample texture for storage, arrays or volumes; resolve MSAA into a separate texture.");
  }
  if (opts.kind === "1d" && (opts.usage.includes("render_attachment") || /^(depth|stencil|bc|etc2|eac|astc)/.test(opts.format))) {
    fail("VGPU-TEXTURE-KIND-INVALID", "1d textures cannot be render attachments or use depth/stencil/compressed formats.", "Use a 2d texture or a plain color format with non-attachment usage.");
  }
  const extent = textureExtent(opts);
  const limitName = opts.kind === "1d" ? "maxTextureDimension1D" : opts.kind === "3d" ? "maxTextureDimension3D" : "maxTextureDimension2D";
  const limit = device.limits?.[limitName];
  if (limit !== void 0 && opts.size.some((size) => size > limit) || opts.kind === "2d-array" && device.limits?.maxTextureArrayLayers !== void 0 && extent[2] > device.limits.maxTextureArrayLayers) {
    fail("VGPU-TEXTURE-LIMIT", "Texture dimensions or layers exceed enabled device limits.", "Reduce the allocation or request sufficient limits when initializing the device.");
  }
  const hasFeature = (name) => device.features?.has(name) ?? false;
  if (opts.usage.includes("storage_binding") && !STORAGE_FORMATS.has(opts.format) && !(opts.format === "bgra8unorm" && hasFeature("bgra8unorm-storage")) && !(TIER1_STORAGE_FORMATS.has(opts.format) && hasFeature("texture-formats-tier1"))) {
    fail("VGPU-TEXTURE-STORAGE-FORMAT", `Format ${opts.format} does not support storage_binding with the enabled features.`, "Choose a supported storage format, enable the required format feature, or explicitly omit storage_binding from usage.");
  }
  if (opts.viewFormats !== void 0 && (!Array.isArray(opts.viewFormats) || !Array.from(opts.viewFormats).every((format) => typeof format === "string" && format.replace(/-srgb$/, "") === opts.format.replace(/-srgb$/, "")))) {
    fail("VGPU-TEXTURE-VIEW-FORMAT", "viewFormats must list formats compatible with the texture format.", "Only the same format or its compatible linear/sRGB counterpart is allowed; native device restrictions also apply.");
  }
}
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// node_modules/@vgpu/core/dist/texture.js
var textureBrand = /* @__PURE__ */ Symbol.for("vgpu/Texture");
var Texture = class {
  device;
  ownership;
  [textureBrand] = true;
  destroySignal = new DestroySignal();
  identity = createResourceIdentity("texture");
  currentGpu;
  currentOptions;
  defaultView = null;
  destroyed = false;
  constructor(device, gpu, options, ownership = "owned") {
    this.device = device;
    this.ownership = ownership;
    this.currentGpu = gpu;
    this.currentOptions = snapshotTextureOptions(options);
  }
  get gpu() {
    return this.currentGpu;
  }
  get options() {
    return this.currentOptions;
  }
  get size() {
    return this.options.size;
  }
  get format() {
    return this.options.format;
  }
  get usage() {
    return this.options.usage;
  }
  get mipLevelCount() {
    return this.options.mipLevelCount ?? 1;
  }
  get sampleCount() {
    return this.options.sampleCount ?? 1;
  }
  get kind() {
    return this.options.kind;
  }
  get layers() {
    return this.options.kind === "2d-array" ? this.options.layers : 1;
  }
  /** Native dimension retained for low-level interop; kind distinguishes arrays. */
  get dimension() {
    return this.options.kind === "2d-array" ? "2d" : this.options.kind;
  }
  get viewFormats() {
    return this.options.viewFormats ?? [];
  }
  get label() {
    return this.options.label;
  }
  get resourceIdentity() {
    return this.identity;
  }
  onDestroy(cb) {
    return this.destroySignal.onDestroy(this, cb);
  }
  get view() {
    this.assertAlive();
    this.defaultView ??= this.createView();
    return this.defaultView;
  }
  createView(desc) {
    this.assertAlive("Texture.createView");
    return this.gpu.createView(this.kind === "2d-array" ? { ...desc, dimension: desc?.dimension ?? "2d-array" } : desc);
  }
  /**
   * Raw, unpadded texel bytes in this texture's own format (row stride padding removed).
   * Tightly packed X, then Y, then Z across the selected mip region; `bgra*` is swizzled to RGBA.
   * Use `readFloats()` for float formats to get decoded component values.
   */
  async read(options) {
    this.assertAlive("Texture.read");
    const result = await this.device.readback.readTexture(this.gpu, options);
    this.assertAlive("Texture.read");
    return result;
  }
  /**
   * Selected texel components decoded to f32, tightly packed in X/Y/Z order.
   * `float16`/`float32` formats keep their HDR values (no clamping); `unorm8` formats are
   * normalized to `[0, 1]` without srgb gamma conversion.
   */
  async readFloats(options) {
    this.assertAlive("Texture.readFloats");
    const info = textureReadbackFormat(this.options.format, "Texture.readFloats");
    const { size } = textureReadSelection(this.gpu, options, "Texture.readFloats");
    validateReadAllocation(size[0] * size[1] * size[2] * info.components * 4, this.device.gpu.limits?.maxBufferSize, "Texture.readFloats");
    return decodeTextureFloats(await this.read(options), this.options.format);
  }
  destroy() {
    if (this.destroyed)
      return;
    this.destroyed = true;
    this.defaultView = null;
    try {
      this.destroySignal.emit(this);
    } finally {
      if (this.ownership !== "external" && !isMockGPUTexture(this.gpu))
        this.gpu.destroy();
    }
  }
  dispose() {
    this.destroy();
  }
  assertAlive(where = "Texture") {
    if (this.destroyed)
      throw new ValidationError({ code: "VGPU-CORE-TEXTURE-DESTROYED", message: "Texture is destroyed", where });
    this.device.assertUsable?.(where);
  }
};
function toGPUTextureDescriptor(opts) {
  const [width, height, depthOrArrayLayers] = textureExtent(opts);
  const desc = {
    label: opts.label,
    size: { width, height, depthOrArrayLayers },
    dimension: opts.kind === "2d-array" ? "2d" : opts.kind,
    format: opts.format,
    usage: textureUsageFlags(opts.usage)
  };
  if (opts.mipLevelCount !== void 0)
    desc.mipLevelCount = opts.mipLevelCount;
  if (opts.sampleCount !== void 0)
    desc.sampleCount = opts.sampleCount;
  if (opts.viewFormats !== void 0)
    desc.viewFormats = [...opts.viewFormats];
  if (opts.kind === "2d-array")
    desc.textureBindingViewDimension = "2d-array";
  return desc;
}

// node_modules/@vgpu/core/dist/device.js
var Device = class {
  gpu;
  adapterInfo;
  queue;
  /** @internal — use Buffer.read() and Texture.read() instead */
  readback;
  isCompatibilityMode;
  scopes = [];
  ownership;
  state = "alive";
  lossInfo;
  observeLoss = true;
  constructor(gpu, adapterInfo = null, ownershipOrOptions = "owned", options = {}) {
    this.gpu = gpu;
    this.adapterInfo = adapterInfo;
    Object.defineProperty(this, "assertUsable", { value: (where) => this.#assertUsable(where) });
    this.ownership = typeof ownershipOrOptions === "string" ? ownershipOrOptions : "owned";
    const opts = typeof ownershipOrOptions === "string" ? options : ownershipOrOptions;
    this.isCompatibilityMode = opts.isCompatibilityMode ?? false;
    this.queue = new Queue(gpu.queue, (where) => this.#assertUsable(where));
    this.readback = new Readback(gpu);
    const lost = gpu.lost;
    if (lost && typeof lost.then === "function") {
      void Promise.resolve(lost).then((info) => {
        if (!this.observeLoss || this.state !== "alive")
          return;
        this.lossInfo = info;
        this.state = "lost";
      }, () => void 0);
    }
  }
  get limits() {
    this.#assertUsable("Device.limits");
    return this.gpu.limits;
  }
  get features() {
    this.#assertUsable("Device.features");
    return this.gpu.features;
  }
  createShader(input) {
    this.#assertUsable("Device.createShader");
    const resolved = typeof input === "string" ? compile(input) : input;
    return new Shader(this.gpu.createShaderModule({ code: resolved.wgsl }), resolved);
  }
  createTexture(opts) {
    this.#assertUsable("Device.createTexture");
    validateTextureOptions(opts, this.gpu);
    const snapshot = snapshotTextureOptions(opts);
    return new Texture(this, this.gpu.createTexture(toGPUTextureDescriptor(snapshot)), snapshot);
  }
  createBuffer(opts) {
    this.#assertUsable("Device.createBuffer");
    const error = validateBufferOptions(opts);
    if (error)
      this.captureError(error);
    const desc = error ? mockBufferDescriptor(Math.max(4, opts.size || 4)) : toGPUBufferDescriptor(opts);
    return new Buffer(this, this.gpu.createBuffer(desc), opts);
  }
  /** Wraps a caller-owned GPUBuffer without taking ownership of its native lifetime. */
  wrapBuffer(buffer) {
    this.#assertUsable("Device.wrapBuffer");
    if (!isExternalBufferShape(buffer)) {
      throw new ValidationError({
        code: "VGPU-EXTERNAL-BUFFER-INVALID",
        message: "Device.wrapBuffer requires a GPUBuffer with finite size and usage properties.",
        where: "Device.wrapBuffer",
        fix: "Pass a live GPUBuffer created for this GPUDevice."
      });
    }
    const options = {
      size: buffer.size,
      usage: bufferUsageNames(buffer.usage),
      ...buffer.label ? { label: buffer.label } : {}
    };
    return new Buffer(this, buffer, options, "external");
  }
  pushErrorScope(filter) {
    this.#assertUsable("Device.pushErrorScope");
    this.scopes.push([]);
    this.gpu.pushErrorScope?.(filter);
  }
  async popErrorScope() {
    this.#assertUsable("Device.popErrorScope");
    const scope = this.scopes.pop();
    const nativeError = await this.gpu.popErrorScope?.();
    this.#assertUsable("Device.popErrorScope");
    return scope?.[0] ?? nativeErrorToVGPUError(nativeError) ?? null;
  }
  #assertUsable(where) {
    if (this.state === "alive")
      return;
    if (this.state === "disposed") {
      throw new ValidationError({
        code: "VGPU-DEVICE-DISPOSED",
        message: "The GPU device wrapper has been disposed.",
        where,
        fix: "Create a new Gpu instance before performing more work."
      });
    }
    const reason = this.lossInfo?.reason;
    const nativeMessage = this.lossInfo?.message;
    throw new ValidationError({
      code: "VGPU-DEVICE-LOST",
      message: `The GPU device was lost${reason ? ` (${reason})` : ""}${nativeMessage ? `: ${nativeMessage}` : "."}`,
      where,
      cause: this.lossInfo
    });
  }
  destroy() {
    if (this.state === "disposed")
      return;
    const wasLost = this.state === "lost";
    this.state = "disposed";
    this.observeLoss = false;
    this.scopes.length = 0;
    this.readback.destroy();
    if (this.ownership === "owned" && !wasLost)
      this.gpu.destroy();
  }
  dispose() {
    this.destroy();
  }
  captureError(error) {
    const scope = this.scopes.at(-1);
    if (scope)
      scope.push(error);
    else
      throw error;
  }
};
function validateBufferOptions(opts) {
  if (!Number.isFinite(opts.size) || opts.size <= 0)
    return invalidUsage("Buffer size must be greater than zero.");
  if (opts.usage.length === 0)
    return invalidUsage("Buffer usage must not be empty.");
  return null;
}
function invalidUsage(message) {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where: "Device.createBuffer" });
}
function toGPUBufferDescriptor(opts) {
  return { label: opts.label, size: opts.size, usage: bufferUsageFlags(opts.usage) };
}
function nativeErrorToVGPUError(error) {
  if (!error)
    return null;
  return new ValidationError({ code: "VGPU-CORE-VALIDATION", message: error.message, where: "GPUDevice.popErrorScope", cause: error });
}
function isExternalBufferShape(value) {
  if (typeof value !== "object" && typeof value !== "function" || value === null)
    return false;
  const buffer = value;
  return Number.isSafeInteger(buffer.size) && (buffer.size ?? -1) >= 0 && Number.isSafeInteger(buffer.usage) && (buffer.usage ?? -1) >= 0 && typeof buffer.destroy === "function";
}
var bufferUsages = ["map_read", "map_write", "copy_src", "copy_dst", "index", "vertex", "uniform", "storage", "indirect", "query_resolve"];
function bufferUsageNames(flags) {
  return bufferUsages.filter((usage) => (flags & bufferUsageFlags([usage])) !== 0);
}

// node_modules/@vgpu/core/dist/bind-group-metadata.js
var layoutMetadata = /* @__PURE__ */ new WeakMap();
var bindGroupMetadata = /* @__PURE__ */ new WeakMap();
function attachBindGroupLayoutMetadata(layout, metadata) {
  layoutMetadata.set(layout, cloneLayoutMetadata(metadata));
  return layout;
}
function bindGroupLayoutMetadata(layout) {
  return layoutMetadata.get(layout);
}
function bindGroupMetadataFor(bindGroup) {
  return bindGroupMetadata.get(bindGroup);
}
function cloneLayoutMetadata(metadata) {
  return { entries: metadata.entries.map((entry) => ({ ...entry })) };
}

// node_modules/vgpu/dist/errors.js
var VGPUError2 = class extends VGPUError {
};
function destroyedBindingError(label, binding, resourceName = "resource") {
  return new VGPUError2({
    code: "VGPU-R1-BINDING-DESTROYED",
    message: `Binding '${binding.name}' (@group(${binding.group}) @binding(${binding.binding})) in '${label}' refers to destroyed resource '${resourceName}'.`,
    where: `${label}.${binding.name}`,
    fix: `Create a live resource and call set({ ${binding.name}: replacement }). Direct attachment references do not follow target.resize(); bind the Target itself to follow replacements. Re-record bundles that captured the old resource.`,
    detail: { binding: binding.binding, bindingName: binding.name, resourceName }
  });
}
function storageStageLimitError(label, stage, entryPoint, count, limit, bindings) {
  const title = stage === "vertex" ? "Vertex" : "Fragment";
  const suffix = stage === "vertex" ? "VERTEX" : "FRAGMENT";
  const limitName = `maxStorageBuffersIn${title}Stage`;
  return new VGPUError2({
    code: `VGPU-LIMIT-STORAGE-${suffix}`,
    message: `${title} entry '${entryPoint}' in '${label}' uses ${count} storage buffer(s), but device limit ${limitName} is ${limit}.`,
    fix: stage === "vertex" ? `Request init({ requiredLimits: { ${limitName}: ${count} } }) if the adapter supports it, or move vertex data to geometry(gpu, ...) vertex streams.` : `Request init({ requiredLimits: { ${limitName}: ${count} } }) if the adapter supports it, or reduce fragment storage buffers.`,
    where: `${label}.pipelineLayout`,
    detail: { stage, entryPoint, count, limit, bindings: bindings.map(({ name, group, binding }) => ({ name, group, binding })) }
  });
}
function textureFilterabilityError(label, binding, format, resourceName, sampler2) {
  return new VGPUError2({
    code: "VGPU-SET-TEXTURE-FILTERABILITY",
    message: `${resourceName} (${format}) cannot satisfy filtering texture '${binding.name}' @group(${binding.group}) @binding(${binding.binding}).`,
    fix: "Use a filterable format; request float32-filterable for rgba32float when supported; or use textureLoad without a sampler.",
    where: `${label}.set`,
    detail: { format, group: binding.group, binding: binding.binding, bindingName: binding.name, resourceName, samplerName: sampler2?.name, samplerGroup: sampler2?.group, samplerBinding: sampler2?.binding }
  });
}
function neverSetError(drawLabel, binding) {
  const fix = missingBindingFix(drawLabel, binding);
  return new VGPUError2({
    code: "VGPU-R1-BINDING-NEVER-SET",
    message: `Unset \`${binding.name}\` @group(${binding.group}) @binding(${binding.binding}) in '${drawLabel}'. Fix: ${fix}; or ${drawLabel}.group(${binding.group}, bindGroup).`,
    where: `${drawLabel}.draw`
  });
}
function ownershipFlipError(name, previous) {
  const previousText = previous === "lib" ? "lib-owned by its first JS set()" : "user-owned by its first resource set()";
  const fix = previous === "lib" ? `Fix: pass a resource from the start: wave.set({ ${name}: new Uniform(gpu.device, { size: 4 }) }).` : `Fix: pass JS values from the first set(): wave.set({ ${name}: jsValue }).`;
  return new VGPUError2({
    code: "VGPU-R1-OWNERSHIP-FLIP",
    message: `\`${name}\` is ${previousText}; ownership cannot change. ${fix}`,
    where: "set"
  });
}
function claimedGroupSetError(label, group) {
  return new VGPUError2({
    code: "VGPU-R4-GROUP-CLAIMED",
    message: `group ${group} of '${label}' is claimed; set() cannot update it.`,
    fix: `Call set() first, or build from ${label}.layout(${group}); pass dynamic offsets to p.draw().`,
    where: `${label}.set`
  });
}
function claimedGroupIncompatibleError(label, group, reason, cause) {
  return new VGPUError2({
    code: "VGPU-R4-GROUP-INCOMPATIBLE",
    message: `claimed group ${group} in '${label}' is incompatible: ${reason}.`,
    fix: `Build from ${label}.layout(${group}, { dynamicOffsets? }) then call ${label}.group(${group}, bindGroup).`,
    where: `${label}.group`,
    cause
  });
}
function claimedGroupNativeValidationError(label, group, cause) {
  return new VGPUError2({
    code: "VGPU-R4-GROUP-VALIDATION",
    message: `WebGPU rejected claimed group ${group} in '${label}'.`,
    fix: `Build from ${label}.layout(${group}); pass offsets via p.draw(draw, { offsets: { ${group}: [...] } }).`,
    where: `${label}.draw`,
    cause,
    detail: { drawLabel: label, group }
  });
}
function blendInvalidError(label, value) {
  return new VGPUError2({
    code: "VGPU-BLEND-INVALID",
    message: `Invalid blend '${String(value)}' in '${label}'.`,
    fix: `Use "alpha", "additive", "premultiplied", or { color, alpha? } components.`,
    where: "draw"
  });
}
function blendConstantInvalidError(label, reason) {
  return new VGPUError2({
    code: "VGPU-BLEND-CONSTANT-INVALID",
    message: `Invalid blendConstant in '${label}': ${reason}`,
    fix: `Use [r, g, b, a] finite numbers with a blend whose color or alpha uses "constant"/"one-minus-constant"; omit it to keep the pass default (0, 0, 0, 0).`,
    where: "draw"
  });
}
function writeMaskInvalidError(label, preview2) {
  return new VGPUError2({
    code: "VGPU-WRITEMASK-INVALID",
    message: `Invalid writeMask ${preview2} in '${label}'.`,
    fix: `Use an array of r/g/b/a; omit it for all channels.`,
    where: "draw"
  });
}
function colorsInvalidError(label, reason, where = "draw") {
  return new VGPUError2({
    code: "VGPU-COLORS-INVALID",
    message: `Invalid colors in '${label}': ${reason}`,
    fix: `Use one { blend?, writeMask? } or null entry per color attachment of the target, aligned by index; omit colors to apply the top-level blend/writeMask to every attachment.`,
    where
  });
}
function cullInvalidError(label, value) {
  return new VGPUError2({
    code: "VGPU-CULL-INVALID",
    message: `Invalid cull '${String(value)}' in '${label}'.`,
    fix: `Use "none", "front", or "back"; omit it for no culling.`,
    where: "draw"
  });
}
function frontFaceInvalidError(label, value) {
  return new VGPUError2({
    code: "VGPU-FRONTFACE-INVALID",
    message: `Invalid frontFace '${String(value)}' in '${label}'.`,
    fix: `Use "ccw" or "cw"; omit it for counter-clockwise.`,
    where: "draw"
  });
}
function unclippedDepthInvalidError(label, reason) {
  return new VGPUError2({
    code: "VGPU-UNCLIPPED-DEPTH-INVALID",
    message: `Invalid unclippedDepth in '${label}': ${reason}`,
    fix: `Use a boolean. unclippedDepth: true needs the "depth-clip-control" device feature \u2014 request it with init({ requiredFeatures: ["depth-clip-control"] }) on an adapter that supports it. Omit the option to keep depth clipping.`,
    where: "draw"
  });
}
function depthInvalidError(label, reason) {
  return new VGPUError2({
    code: "VGPU-DEPTH-INVALID",
    message: `Invalid depth in '${label}': ${reason}`,
    fix: `Use false or { write?, compare?, bias?, biasSlopeScale?, biasClamp? }; omit it for { write: true, compare: "less-equal" }.`,
    where: "draw"
  });
}
function stencilInvalidError(label, reason, where = "draw") {
  return new VGPUError2({
    code: "VGPU-STENCIL-INVALID",
    message: `Invalid stencil in '${label}': ${reason}`,
    fix: `Use { front?, back?, readMask?, writeMask?, ref? } with GPUCompareFunction/GPUStencilOperation faces and u32 masks, against a target whose depth format has a stencil aspect (depth: "depth24plus-stencil8"); omit it for WebGPU's pass-through defaults.`,
    where
  });
}
function multisampleInvalidError(label, reason, where = "draw") {
  return new VGPUError2({
    code: "VGPU-MULTISAMPLE-INVALID",
    message: `Invalid multisample in '${label}': ${reason}`,
    fix: `Use { alphaToCoverage?, mask? }: alphaToCoverage needs a target created with msaa: true, and mask must be an integer in [0, 0xFFFFFFFF] (bits above the target's sampleCount are ignored). Omit multisample for full-coverage defaults.`,
    where
  });
}
function constantsInvalidError(label, reason, where = "draw") {
  return new VGPUError2({
    code: "VGPU-CONSTANTS-INVALID",
    message: `Invalid constants in '${label}': ${reason}`,
    fix: `Key WGSL \`override\` constants by name, or by the decimal string of N when the declaration has @id(N); values are finite numbers or booleans, converted to the override's WGSL type (bool/i32/u32/f32/f16). Every override without a default value must be provided. Omit constants to keep the WGSL defaults.`,
    where
  });
}
function entryInvalidError(label, reason, where = "draw") {
  return new VGPUError2({
    code: "VGPU-ENTRY-INVALID",
    message: `Invalid entry in '${label}': ${reason}`,
    fix: `Name an entry point declared in the shader with the matching stage \u2014 { vertex?, fragment? } strings for draw, one @compute name string for compute. Omit entry (or a field) to use the first entry point of that stage.`,
    where
  });
}
function indirectInvalidError(label, reason, where) {
  return new VGPUError2({
    code: "VGPU-INDIRECT-INVALID",
    message: `Invalid indirect in '${label}': ${reason}`,
    fix: `Pass a storage buffer created with storage(gpu, bytes, { indirect: true }) \u2014 bare, or as { buffer, offset? } with a 4-aligned byte offset \u2014 sized so the GPU-read arguments fit: 16 bytes for drawIndirect, 20 for drawIndexedIndirect, 12 for dispatchWorkgroupsIndirect. Omit indirect to use CPU-side counts.`,
    where
  });
}
function passPreserveMsaaError() {
  return new VGPUError2({
    code: "VGPU-PASS-PRESERVE-MSAA",
    message: "clear:false cannot preserve MSAA; use a non-MSAA target.",
    fix: "Use non-MSAA for accumulation.",
    where: "Frame.pass"
  });
}
function passClearDepthInvalidError(value, reason = "expected a number in [0, 1].", fix = `Use 1 (default), or 0 with depth: { compare: "greater" } for reversed-Z.`) {
  return new VGPUError2({
    code: "VGPU-PASS-CLEARDEPTH-INVALID",
    message: `clearDepth received ${String(value)}; ${reason}`,
    fix,
    where: "Frame.pass"
  });
}
function passViewportInvalidError(reason) {
  return new VGPUError2({
    code: "VGPU-PASS-VIEWPORT-INVALID",
    message: `Invalid viewport: ${reason}`,
    fix: `Use { x?, y?, width, height, minDepth?, maxDepth? } finite numbers within device limits; omit it for the full target.`,
    where: "Frame.pass"
  });
}
function passScissorInvalidError(reason) {
  return new VGPUError2({
    code: "VGPU-PASS-SCISSOR-INVALID",
    message: `Invalid scissor: ${reason}`,
    fix: `Use [x, y, width, height] non-negative integers with x + width and y + height within the target's current pixel size; omit it for the full target.`,
    where: "Frame.pass"
  });
}
function passPreserveClearDepthError() {
  return new VGPUError2({
    code: "VGPU-PASS-PRESERVE-CLEARDEPTH",
    message: "clear:false preserves depth; clearDepth cannot apply.",
    fix: "Remove clearDepth, or let the pass clear.",
    where: "Frame.pass"
  });
}
function passClearStencilInvalidError(reason) {
  return new VGPUError2({
    code: "VGPU-PASS-CLEARSTENCIL-INVALID",
    message: `clearStencil ${reason}`,
    fix: `Use an integer in [0, 0xFFFFFFFF] on a target whose depth format has a stencil aspect, e.g. depth: "depth24plus-stencil8"; the value is masked to the stencil aspect's bit width.`,
    where: "Frame.pass"
  });
}
function passPreserveClearStencilError() {
  return new VGPUError2({
    code: "VGPU-PASS-PRESERVE-CLEARSTENCIL",
    message: "clear:false preserves stencil; clearStencil cannot apply.",
    fix: "Remove clearStencil, or let the pass clear.",
    where: "Frame.pass"
  });
}
function passDepthReadOnlyError(reason, fix, where = "Frame.pass") {
  return new VGPUError2({
    code: "VGPU-PASS-DEPTH-READONLY",
    message: `depthReadOnly ${reason}`,
    fix,
    where
  });
}
function passDepthReadOnlyMsaaError() {
  return new VGPUError2({
    code: "VGPU-PASS-DEPTH-READONLY-MSAA",
    message: `depthReadOnly cannot read an MSAA target's depth: multisampled depth is stored with storeOp "discard", so a read-only pass tests against discarded contents.`,
    fix: "Use a non-MSAA target for read-only depth, or drop depthReadOnly and let the pass own its depth.",
    where: "Frame.pass"
  });
}
function timerInvalidError(reason, fix, where = "timer") {
  return new VGPUError2({
    code: "VGPU-TIMER-INVALID",
    message: `Invalid timer use: ${reason}`,
    fix,
    where
  });
}
function visibilityInvalidError(reason, fix, where = "visibility") {
  return new VGPUError2({
    code: "VGPU-VIS-INVALID",
    message: `Invalid visibility use: ${reason}`,
    fix,
    where
  });
}
function queryNoVisibilityError() {
  return new VGPUError2({
    code: "VGPU-QUERY-NO-VISIBILITY",
    message: "occlusion() needs the pass to be opened with a visibility instance; the render pass has no occlusionQuerySet to write into.",
    fix: "Open the pass with f.pass({ target, visibility: vis }, ...) using the visibility(gpu) instance that created the query handle.",
    where: "FramePass.occlusion"
  });
}
function queryNestedError() {
  return new VGPUError2({
    code: "VGPU-QUERY-NESTED",
    message: "occlusion() cannot nest inside an active occlusion() body; WebGPU allows one active occlusion query per pass at a time.",
    fix: "Encode each occlusion scope sequentially: p.occlusion(a, ...); p.occlusion(b, ...).",
    where: "FramePass.occlusion"
  });
}
function targetRequiredError(where = "Frame.pass") {
  return new VGPUError2({
    code: "VGPU-TARGET-REQUIRED",
    message: "Target required. Fix: pass surface(gpu, canvas) or target(gpu, { size }) as { target }.",
    where
  });
}
function meshError(code, where, message, fix) {
  return new VGPUError2({ code, message: `${code}: ${message}`, fix, where });
}
function meshLayoutInvalidError(where, message) {
  return meshError("VGPU-MESH-LAYOUT-INVALID", where, message, "Fix attributes/formats/offsets; use non-numeric names and 4-aligned stride <= 2048.");
}
function meshLimitExceededError(where, message) {
  return meshError("VGPU-MESH-LIMIT-EXCEEDED", where, message, "Use <= 8 buffers and <= 16 attributes (or the device limits).");
}
function meshLocationConflictError(where, location) {
  return meshError("VGPU-MESH-LOCATION-CONFLICT", where, `Duplicate geometry @location(${location}).`, "Use unique locations, or omit them for name matching.");
}
function meshDataMisalignedError(where, message) {
  return meshError("VGPU-MESH-DATA-MISALIGNED", where, message, "Fix: repack data, set matching stride, or give raw buffers an explicit count.");
}
function meshRangeInvalidError(where, message) {
  return meshError("VGPU-MESH-RANGE-INVALID", where, message, "Use index ranges for indexed geometries, vertex ranges otherwise, within geometry counts.");
}
function meshWriteRangeError(where, message) {
  return meshError("VGPU-MESH-WRITE-RANGE", where, message, "Write within the buffer byteLength, or create a larger geometry.");
}
function meshAttributeUnmatchedError(where, name, available = []) {
  return meshError("VGPU-MESH-ATTRIBUTE-UNMATCHED", where, `Geometry attribute '${name}' has no shader input.`, `Use shader name${available.length ? ` (${available.join(",")})` : ""} or { location:n }.`);
}
function meshAttributeAmbiguousError(where, name, locations) {
  return meshError("VGPU-MESH-ATTRIBUTE-UNMATCHED", where, `Geometry attribute '${name}' matches locations ${locations.join(",")}.`, "Rename inputs or set { location:n }.");
}
function meshInputMissingError(where, name, available = []) {
  return meshError("VGPU-MESH-INPUT-MISSING", where, `Geometry lacks shader input '${name}'.`, `Add/remove it. Geometry attributes: ${available.join(",") || "none"}.`);
}
function meshFormatMismatchError(where, name, meshFormat, shaderType) {
  return meshError("VGPU-MESH-FORMAT-MISMATCH", where, `Attribute '${name}' ${meshFormat} != shader ${shaderType}.`, "Match the float/sint/uint shader base type; widths may differ.");
}
function pipelineLayoutGapError(group) {
  return new VGPUError2({
    code: "VGPU-PIPELINE-LAYOUT-GAP",
    message: `Pipeline bind group ${group} is missing.`,
    fix: "Use consecutive @group() indices starting at 0.",
    where: "pipeline layout"
  });
}
function compileFailedError(where, cause, signature) {
  return new VGPUError2({
    code: "VGPU-COMPILE-FAILED",
    message: "WebGPU pipeline compilation failed.",
    fix: "Check WGSL, vertex layouts, and target signature.",
    where,
    cause,
    detail: signature ? { signature } : void 0
  });
}
function compileDisposedError(where) {
  return new VGPUError2({
    code: "VGPU-COMPILE-DISPOSED",
    message: "GPU disposed during pipeline compilation.",
    where
  });
}
function compileSignatureInvalidError(where, reason) {
  return new VGPUError2({
    code: "VGPU-COMPILE-SIGNATURE-INVALID",
    message: `Invalid TargetSignature: ${reason}`,
    fix: "Pass { colors, depth?, sampleCount?:1|4 } or a Target.",
    where
  });
}
function targetStencilOnlyDepthError(format) {
  return new VGPUError2({
    code: "VGPU-TARGET-DEPTH-STENCIL-ONLY",
    message: `depth received '${format}'; stencil-only depth targets are not supported yet.`,
    fix: `Use a format with a depth aspect such as "depth24plus" or "depth24plus-stencil8".`,
    where: "target"
  });
}
function targetSizeRequiredError() {
  return new VGPUError2({
    code: "VGPU-TARGET-SIZE-REQUIRED",
    message: "Target size required. Fix: target(gpu, { size: [w,h] }); update surface-derived targets in onResize.",
    where: "target"
  });
}
function surfaceNotInFrameError(where) {
  return new VGPUError2({
    code: "VGPU-SURFACE-NOT-IN-FRAME",
    message: "Surface targets are only available inside frame(gpu).",
    fix: "surface passes must run inside frame(gpu, ...); precompile against an offscreen target(gpu, ...) instead",
    where
  });
}
function surfaceContextError() {
  return new VGPUError2({
    code: "VGPU-SURFACE-CONTEXT",
    message: "Canvas WebGPU context failed. Fix: check navigator.gpu and remove any existing 2d/webgl context.",
    where: "surface"
  });
}
function surfaceDuplicateError(label) {
  return new VGPUError2({
    code: "VGPU-SURFACE-DUPLICATE",
    message: `Canvas already has surface${label ? ` '${label}'` : ""}. Fix: reuse or dispose it.`,
    where: "surface"
  });
}
function surfaceDisposedError(label) {
  return new VGPUError2({
    code: "VGPU-SURFACE-DISPOSED",
    message: `Surface '${label ?? "surface"}' is disposed. Fix: call surface(gpu, canvas).`,
    where: "surface"
  });
}
function surfaceAutoResizeUnsupportedError() {
  return new VGPUError2({
    code: "VGPU-SURFACE-AUTORESIZE-UNSUPPORTED",
    message: "autoResize needs clientWidth. Fix: call surface.resize([w,h]) for OffscreenCanvas; onResize still fires.",
    where: "surface"
  });
}
function surfaceResizeReentrantError(label) {
  return new VGPUError2({
    code: "VGPU-SURFACE-RESIZE-REENTRANT",
    message: `Cannot resize this surface${label ? ` '${label}'` : ""} in onResize. Fix: resize derived targets only.`,
    where: "surface.resize"
  });
}
function clearColorInvalidError(where) {
  return new VGPUError2({
    code: "VGPU-CLEAR-COLOR-INVALID",
    message: `Invalid ${where}: expected four finite numbers.`,
    fix: "Assign [r, g, b, a] or a GPUColor object ({ r, g, b, a }).",
    where
  });
}
function clockDeltaInvalidError(received) {
  return new VGPUError2({
    code: "VGPU-CLOCK-DELTA-INVALID",
    message: `clock.advance() received ${String(received)}; expected a finite, non-negative number of seconds.`,
    fix: "Pass the elapsed seconds, e.g. clock(gpu).advance(1 / 60); use frame(gpu) alone to advance with wall-clock time.",
    where: "clock.advance"
  });
}
function frameReentrantError() {
  return new VGPUError2({
    code: "VGPU-FRAME-REENTRANT",
    message: "Nested frame(gpu) is invalid. Fix: queue work for the next frame.",
    where: "frame"
  });
}
function frameCanceledError(where) {
  return new VGPUError2({
    code: "VGPU-FRAME-CANCELED",
    message: "the frame was canceled; its command encoder was dropped and nothing more can be encoded or submitted on it.",
    fix: "Open a new frame(gpu) for further work; cancel() is the last operation on a frame.",
    where
  });
}
function framePassActiveError(where) {
  return new VGPUError2({
    code: "VGPU-FRAME-PASS-ACTIVE",
    message: "the frame cannot be canceled while a pass callback is active.",
    fix: "Return from the frame.pass(...) callback first, then call frame.cancel(); this keeps pass descriptor resources alive until the pass is closed.",
    where
  });
}
function frameAlreadySubmittedError(where) {
  return new VGPUError2({
    code: "VGPU-FRAME-SUBMITTED",
    message: "the frame was already submitted; submitted GPU work cannot be canceled.",
    fix: "Call cancel() only on a frame you decided not to submit; the frame you did submit needs no cleanup.",
    where
  });
}
function incompatibleResourceError(binding, expected, fix) {
  return new VGPUError2({
    code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
    message: `binding \`${binding.name}\` @group(${binding.group}) @binding(${binding.binding}) needs ${expected}.`,
    fix,
    where: "set"
  });
}
function unsupportedError(where, message, fix) {
  return new VGPUError2({ code: "VGPU-RING1-UNSUPPORTED", message, fix, where });
}
function setValueInvalidError(detail, message) {
  return new VGPUError2({
    code: "VGPU-SET-VALUE-INVALID",
    message: `Invalid WGSL value at '${detail.path}': ${message}.`,
    fix: "Pass the exact reflected structure, vector, matrix, and array shapes; use integral in-range values for i32/u32.",
    where: "set",
    detail
  });
}
function malformedShaderSourceError(input) {
  if (hasVersion(input) && input.version !== 1) {
    return new VGPUError2({
      code: "VGPU-SHADER-SOURCE-INVALID",
      message: `VGPU-SHADER-SOURCE-INVALID: unsupported ShaderSource v${String(input.version)}; expected v1. Fix: update vgpu or regenerate it.`,
      where: "shader source"
    });
  }
  return new VGPUError2({
    code: "VGPU-SHADER-SOURCE-INVALID",
    message: `VGPU-SHADER-SOURCE-INVALID: expected WGSL or { version, wgsl }, got ${previewShaderSource(input)}. Fix: configure @vgpu/wgsl loader-vite or loader-webpack.`,
    where: "shader source"
  });
}
function hasVersion(input) {
  return typeof input === "object" && input !== null && "version" in input;
}
function previewShaderSource(input) {
  if (typeof input !== "object" || input === null)
    return typeof input;
  try {
    const json = JSON.stringify(input);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  } catch {
    return "object";
  }
}
function missingBindingFix(drawLabel, binding) {
  switch (binding.kind) {
    case "sampler":
      return `${drawLabel}.set({${binding.name}:sampler(gpu)})`;
    case "texture":
      return `${drawLabel}.set({${binding.name}:scene.color})`;
    case "buffer":
      return binding.addressSpace === "uniform" ? `${drawLabel}.set({${binding.name}:{ /* values */ }})` : `${drawLabel}.set({${binding.name}:buffer})`;
    default:
      return `${drawLabel}.set({${binding.name}:resource})`;
  }
}

// node_modules/vgpu/dist/kernel.js
var PHASES = ["scheduler", "resource", "service"];
function serviceToken(name) {
  return { name };
}
var kernels = /* @__PURE__ */ new WeakMap();
function kernelOf(gpu) {
  const kernel = kernels.get(gpu);
  if (!kernel) {
    throw new VGPUError2({
      code: "VGPU-GPU-FOREIGN",
      message: "This object was not created by init(); it has no vgpu kernel.",
      fix: "Pass the gpu returned by init() from vgpu, vgpu/node or vgpu/mock.",
      where: "gpu"
    });
  }
  return kernel;
}
var KernelImpl = class {
  device;
  #services = /* @__PURE__ */ new Map();
  #owners = new Map(PHASES.map((phase) => [phase, /* @__PURE__ */ new Set()]));
  #errorListeners = /* @__PURE__ */ new Set();
  #pendingDeliveries = /* @__PURE__ */ new Set();
  #settledSources = /* @__PURE__ */ new Set();
  #disposed = false;
  constructor(device) {
    this.device = device;
  }
  get disposed() {
    return this.#disposed;
  }
  service(token, factory) {
    const existing = this.#services.get(token);
    if (existing !== void 0)
      return existing;
    const created = factory(this);
    this.#services.set(token, created);
    return created;
  }
  peekService(token) {
    return this.#services.get(token);
  }
  own(phase, disposer) {
    const set = this.#owners.get(phase);
    set.add(disposer);
    return () => {
      set.delete(disposer);
    };
  }
  addErrorListener(cb) {
    this.#errorListeners.add(cb);
    return () => {
      this.#errorListeners.delete(cb);
    };
  }
  reportError(error) {
    if (this.#disposed)
      return Promise.resolve();
    const delivery = Promise.resolve().then(() => {
      const listeners = [...this.#errorListeners];
      if (!listeners.length) {
        console.error(error);
        return;
      }
      for (const listener of listeners) {
        try {
          listener(error);
        } catch (listenerError) {
          console.error(listenerError);
        }
      }
    });
    return this.trackDelivery(delivery);
  }
  trackDelivery(promise) {
    const tracked = Promise.resolve(promise).then(() => void 0, (error) => {
      console.error(error);
    });
    this.#pendingDeliveries.add(tracked);
    void tracked.finally(() => this.#pendingDeliveries.delete(tracked));
    return tracked;
  }
  registerSettledSource(source) {
    this.#settledSources.add(source);
    return () => {
      this.#settledSources.delete(source);
    };
  }
  async settled() {
    const snapshot = [
      ...this.#pendingDeliveries,
      ...[...this.#settledSources].flatMap((source) => source())
    ];
    await Promise.allSettled(snapshot);
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#disposed = true;
    for (const phase of PHASES) {
      const set = this.#owners.get(phase);
      for (const disposer of [...set])
        disposer();
      set.clear();
    }
    this.#services.clear();
    this.#settledSources.clear();
    this.#errorListeners.clear();
    this.device.dispose();
  }
};
function attachKernel(device) {
  const kernel = new KernelImpl(device);
  const gpu = {
    device,
    gpu: device.gpu,
    get disposed() {
      return kernel.disposed;
    },
    onError: (cb) => kernel.addErrorListener(cb),
    settled: () => kernel.settled(),
    dispose: () => {
      kernel.dispose();
    }
  };
  kernels.set(gpu, kernel);
  return gpu;
}
async function createCoreGpu(entry, opts = {}, adapterFactory) {
  return attachKernel(await createDevice(entry, opts, adapterFactory));
}
async function createDevice(entry, opts, adapterFactory) {
  if (opts.adapter || adapterFactory)
    return (opts.adapter ?? adapterFactory()).requestDevice(opts);
  if (entry === "browser")
    return requestBrowserDevice(opts);
  throw unsupportedError("init", `init(${entry}) requires adapterFactory.`);
}
async function requestBrowserDevice(opts) {
  const nav = globalThis.navigator;
  const adapter = await nav.gpu?.requestAdapter({ powerPreference: opts.powerPreference });
  if (!adapter)
    throw unsupportedError("init", "navigator.gpu.requestAdapter() returned null.");
  validateRequiredFeatures(adapter.features, opts.requiredFeatures);
  const gpuDevice = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  return new Device(gpuDevice, adapter.info ?? null);
}

// node_modules/vgpu/dist/lifecycle.js
function assertDeviceUsable(device, where) {
  device.assertUsable(where);
}
function assertBufferUsable(buffer, where) {
  buffer.assertUsable(where);
}

// node_modules/vgpu/dist/draw-protocols.js
var BINDING_RESOURCE = /* @__PURE__ */ Symbol("vgpu.bindingResource");
function bindingResourceOf(value) {
  const method = typeof value === "object" && value !== null ? value[BINDING_RESOURCE] : void 0;
  return typeof method === "function" ? value : void 0;
}
var geometryLayoutResolver = /* @__PURE__ */ Symbol("vgpu.geometry.layoutResolver");

// node_modules/vgpu/dist/live-kernel.js
function liveKernel(gpu, where) {
  const kernel = kernelOf(gpu);
  if (kernel.disposed)
    throw gpuDisposedError(where);
  return kernel;
}
function gpuDisposedError(where) {
  return new VGPUError2({
    code: "VGPU-GPU-DISPOSED",
    message: `${where}() ran after gpu.dispose(); the device and everything it owned are gone.`,
    fix: "Create resources before disposing the gpu, or init() a new one.",
    where
  });
}
function ownResource(kernel, resource, destroy, onDestroyed) {
  const release = kernel.own("resource", () => destroy(resource));
  onDestroyed?.(release);
  return resource;
}

// node_modules/vgpu/dist/scene/geometry-descriptor.js
var Geometry = class {
  vertexCount;
  indexCount;
  instanceCount;
  vertexBuffers;
  indexBuffer;
  indexFormat;
  vertexBufferLayouts;
  topology;
  stripIndexFormat;
  buffers;
  #indexOwned;
  #indexByteLength;
  #normalized;
  #resolvedLayouts = /* @__PURE__ */ new Map();
  #destroyHooks = /* @__PURE__ */ new Set();
  #destroyed = false;
  constructor(device, opts) {
    const where = "geometry";
    if (opts.buffers.length > 8)
      throw meshLimitExceededError(where, `${opts.buffers.length} vertex buffers exceed limit 8.`);
    let attrCount = 0;
    const locations = /* @__PURE__ */ new Set();
    const normalized = opts.buffers.map((buffer, i) => {
      const n = normalizeBuffer(device, buffer, `${where}.buffers[${i}]`);
      attrCount += n.attributes.length;
      for (const attr of n.attributes) {
        if (attr.location === void 0)
          continue;
        if (locations.has(attr.location))
          throw meshLocationConflictError(`${where}.buffers[${i}]`, attr.location);
        locations.add(attr.location);
      }
      return n;
    });
    const maxAttributes = device.gpu.limits.maxVertexAttributes;
    if (attrCount > maxAttributes)
      throw meshLimitExceededError(where, `${attrCount} attributes exceed device limit ${maxAttributes}.`);
    const topology = opts.topology ?? "triangle-list";
    if (!TOPOLOGIES.has(topology))
      throw meshLayoutInvalidError(where, `Invalid topology: ${String(topology)}.`);
    const index = normalizeIndex(device, opts, where);
    const vertexCapacity = deriveCount(normalized, "vertex");
    const instanceCapacity = deriveCount(normalized, "instance");
    requireExplicitRawCount(normalized, "vertex", opts.vertexCount ?? vertexCapacity, where);
    requireExplicitRawCount(normalized, "instance", opts.instanceCount ?? instanceCapacity, where);
    validateOptionalCapacity(where, "vertexCount", opts.vertexCount, vertexCapacity);
    validateOptionalCapacity(where, "instanceCount", opts.instanceCount, instanceCapacity);
    validateOptionalCapacity(where, "indexCount", opts.indexCount, index.count);
    this.topology = topology;
    this.stripIndexFormat = topology.endsWith("strip") ? index.format : void 0;
    this.#normalized = normalized;
    this.vertexBufferLayouts = Object.freeze(normalized.map((n) => n.layout));
    this.vertexBuffers = Object.freeze(normalized.map((n) => n.gpu));
    this.buffers = Object.freeze(normalized.map((n, i) => new InternalGeometryBuffer(`${where}.buffers[${i}]`, n)));
    this.vertexCount = opts.vertexCount ?? vertexCapacity;
    this.instanceCount = opts.instanceCount ?? instanceCapacity;
    this.indexBuffer = index.gpu;
    this.indexFormat = index.format;
    this.indexCount = opts.indexCount ?? index.count;
    this.#indexOwned = index.owned;
    this.#indexByteLength = index.byteLength;
    lockPublicGeometryProperties(this);
  }
  /** @internal Resolves named attributes for one reflected vertex entry point. */
  [geometryLayoutResolver](inputs, where) {
    if (this.#destroyed)
      throw meshLayoutInvalidError(where, "Geometry is destroyed; create a live geometry.");
    const key = inputs.map((input) => `${input.name}:${input.location}:${shaderTypeBase(input.type)}`).join("|");
    const cached = this.#resolvedLayouts.get(key);
    if (cached)
      return cached;
    const covered = /* @__PURE__ */ new Set();
    const names = this.#normalized.flatMap((buffer) => buffer.attributes.map((attribute) => attribute.name));
    const layouts = this.#normalized.map((buffer) => {
      const source = [...buffer.layout.attributes];
      const attributes = buffer.attributes.map((attribute, index) => {
        const matches = attribute.location === void 0 ? inputs.filter((input2) => input2.name === attribute.name) : [];
        if (attribute.location === void 0 && matches.length === 0)
          throw meshAttributeUnmatchedError(where, attribute.name, inputs.map((input2) => input2.name));
        if (matches.length > 1)
          throw meshAttributeAmbiguousError(where, attribute.name, matches.map((input2) => input2.location));
        const location = attribute.location ?? matches[0].location;
        if (covered.has(location))
          throw meshLocationConflictError(where, location);
        covered.add(location);
        const input = inputs.find((candidate) => candidate.location === location);
        if (input && vertexFormatBase(attribute.format) !== shaderTypeBase(input.type))
          throw meshFormatMismatchError(where, attribute.name, attribute.format, shaderTypeBase(input.type));
        return Object.freeze({ ...source[index], shaderLocation: location });
      });
      return Object.freeze({ arrayStride: buffer.layout.arrayStride, ...buffer.layout.stepMode ? { stepMode: buffer.layout.stepMode } : {}, attributes: Object.freeze(attributes) });
    });
    for (const input of inputs)
      if (!covered.has(input.location))
        throw meshInputMissingError(where, input.name, names);
    const result = Object.freeze(layouts);
    this.#resolvedLayouts.set(key, result);
    return result;
  }
  /** Creates a frozen range view sharing this geometry's buffers and layout identity. */
  slice(opts = {}) {
    return new InternalGeometrySlice(this, opts);
  }
  /** Updates bytes in vertex buffer stream 0 without resizing it. */
  write(data, byteOffset = 0) {
    const first = this.buffers[0];
    if (!first)
      throw meshWriteRangeError("geometry.write", "No vertex buffer 0; add one before writing.");
    first.write(data, byteOffset);
  }
  /** Updates bytes in the owned index buffer without resizing it. */
  writeIndices(data, byteOffset = 0) {
    if (this.#destroyed)
      throw meshWriteRangeError("geometry.writeIndices", "Geometry is destroyed; create a new geometry before writing.");
    if (!this.#indexOwned || this.#indexByteLength === void 0)
      throw meshWriteRangeError("geometry.writeIndices", "No owned index buffer; write caller-owned buffers directly.");
    validateWriteRange("geometry.writeIndices", this.#indexByteLength, data.byteLength, byteOffset);
    this.#indexOwned.write(data, byteOffset);
  }
  /** Destroys buffers owned by this geometry; caller-owned buffers are untouched. */
  destroy() {
    if (this.#destroyed)
      return;
    this.#destroyed = true;
    for (const buffer of this.buffers)
      buffer.destroyOwned();
    this.#indexOwned?.destroy();
    for (const hook of [...this.#destroyHooks])
      hook();
    this.#destroyHooks.clear();
  }
  /**
   * @internal Ownership hook: runs once, right after `destroy()` freed the buffers, so the owner
   * that registered this geometry with the kernel can drop its teardown registration.
   */
  onDestroy(hook) {
    if (this.#destroyed) {
      hook();
      return () => void 0;
    }
    this.#destroyHooks.add(hook);
    return () => {
      this.#destroyHooks.delete(hook);
    };
  }
};
var InternalGeometryBuffer = class {
  where;
  inner;
  gpu;
  stride;
  stepMode;
  #state = { destroyed: false };
  constructor(where, inner) {
    this.where = where;
    this.inner = inner;
    this.gpu = inner.gpu;
    this.stride = inner.stride;
    this.stepMode = inner.stepMode;
    Object.freeze(this);
  }
  write(data, byteOffset = 0) {
    if (this.#state.destroyed)
      throw meshWriteRangeError(this.where, "Geometry is destroyed; create a new geometry before writing.");
    if (!this.inner.owned || this.inner.byteLength === void 0)
      throw meshWriteRangeError(this.where, "Caller-owned buffer; write it directly.");
    validateWriteRange(this.where, this.inner.byteLength, byteLength(data), byteOffset);
    this.inner.owned.write(data, byteOffset);
  }
  destroyOwned() {
    this.#state.destroyed = true;
    this.inner.owned?.destroy();
  }
};
var InternalGeometrySlice = class {
  geometry;
  vertexCount;
  indexCount;
  instanceCount;
  vertexBuffers;
  indexBuffer;
  indexFormat;
  vertexBufferLayouts;
  topology;
  stripIndexFormat;
  firstIndex;
  baseVertex;
  firstVertex;
  [geometryLayoutResolver](inputs, where) {
    return this.geometry[geometryLayoutResolver](inputs, where);
  }
  constructor(geometry2, opts) {
    this.geometry = geometry2;
    this.vertexBuffers = geometry2.vertexBuffers;
    this.indexBuffer = geometry2.indexBuffer;
    this.indexFormat = geometry2.indexFormat;
    this.vertexBufferLayouts = geometry2.vertexBufferLayouts;
    this.topology = geometry2.topology;
    this.stripIndexFormat = geometry2.stripIndexFormat;
    if (geometry2.indexBuffer) {
      if (opts.firstVertex !== void 0 || opts.vertexCount !== void 0)
        throw meshRangeInvalidError("geometry.slice", "Indexed slice needs firstIndex/indexCount/baseVertex; omit vertex range fields.");
      const firstIndex = opts.firstIndex ?? 0;
      const max = geometry2.indexCount ?? 0;
      const count = opts.indexCount ?? max - firstIndex;
      validateRange("geometry.slice", "firstIndex", firstIndex, max);
      validateRange("geometry.slice", "indexCount", count, max - firstIndex);
      validateRange("geometry.slice", "baseVertex", opts.baseVertex ?? 0, Number.MAX_SAFE_INTEGER);
      this.firstIndex = firstIndex;
      this.indexCount = count;
      this.baseVertex = opts.baseVertex ?? 0;
      this.vertexCount = geometry2.vertexCount;
    } else {
      if (opts.firstIndex !== void 0 || opts.indexCount !== void 0 || opts.baseVertex !== void 0)
        throw meshRangeInvalidError("geometry.slice", "Non-indexed slice needs firstVertex/vertexCount; omit index range fields.");
      const firstVertex = opts.firstVertex ?? 0;
      const max = geometry2.vertexCount ?? 0;
      const count = opts.vertexCount ?? max - firstVertex;
      validateRange("geometry.slice", "firstVertex", firstVertex, max);
      validateRange("geometry.slice", "vertexCount", count, max - firstVertex);
      this.firstVertex = firstVertex;
      this.vertexCount = count;
      this.indexCount = geometry2.indexCount;
    }
    validateRange("geometry.slice", "instanceCount", opts.instanceCount ?? geometry2.instanceCount ?? 0, Number.MAX_SAFE_INTEGER);
    this.instanceCount = opts.instanceCount ?? geometry2.instanceCount;
    Object.freeze(this);
  }
};
function geometry(gpu, input) {
  const kernel = liveKernel(gpu, "geometry");
  const opts = isRecipe(input) ? input.build(kernel.device) : input;
  return ownGeometry(kernel, new Geometry(kernel.device, opts));
}
function isRecipe(value) {
  return "build" in value && typeof value.build === "function";
}
function ownGeometry(kernel, value) {
  return ownResource(kernel, value, (owned) => owned.destroy(), (cb) => {
    value.onDestroy(cb);
  });
}
function formatByteSize(fmt) {
  if (fmt === "unorm10-10-10-2" || fmt === "unorm8x4-bgra")
    return 4;
  const m = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x([234]))?$/.exec(fmt);
  if (!m)
    return 0;
  const [, kind, bits, lanes] = m;
  if (bits === "32" ? /norm/.test(kind) : !lanes || lanes === "3" || bits === "8" && kind === "float")
    return 0;
  return Number(bits) / 8 * Number(lanes ?? 1);
}
function normalizeBuffer(device, opts, where) {
  if (opts.data !== void 0 && opts.buffer !== void 0)
    throw meshLayoutInvalidError(where, "Choose data or buffer, not both.");
  const stepMode = opts.stepMode ?? "vertex";
  if (stepMode !== "vertex" && stepMode !== "instance")
    throw meshLayoutInvalidError(where, `Invalid stepMode: ${String(stepMode)}.`);
  const attrs = [];
  const metas = [];
  let packedSize = 0;
  for (const [name, value] of Object.entries(opts.attributes)) {
    if (/^\d+$/.test(name))
      throw meshLayoutInvalidError(where, `Attribute '${name}' is numeric; use a non-numeric name.`);
    const desc = typeof value === "string" ? { format: value } : value;
    const size = formatByteSize(desc.format);
    if (!size)
      throw meshLayoutInvalidError(where, `Unknown GPUVertexFormat '${desc.format}'.`);
    const attrOffset = desc.offset ?? packedSize;
    const align2 = Math.min(4, size);
    if (!Number.isInteger(attrOffset) || attrOffset < 0 || attrOffset % align2 !== 0)
      throw meshLayoutInvalidError(where, `Attribute '${name}' offset ${String(attrOffset)} needs ${align2}-byte alignment.`);
    if (desc.location !== void 0 && (!Number.isInteger(desc.location) || desc.location < 0 || desc.location >= device.gpu.limits.maxVertexAttributes))
      throw meshLayoutInvalidError(where, `Location ${String(desc.location)} for '${name}' is outside limit ${device.gpu.limits.maxVertexAttributes}.`);
    attrs.push({ shaderLocation: desc.location ?? attrs.length, offset: attrOffset, format: desc.format });
    metas.push({ name, format: desc.format, location: desc.location });
    packedSize += size;
  }
  const stride = opts.stride ?? roundUp4(packedSize);
  if (!Number.isInteger(stride) || stride <= 0 || stride > 2048 || stride % 4 !== 0)
    throw meshLayoutInvalidError(where, `Stride ${String(stride)} must be 4-aligned in [4,2048].`);
  for (const [i, attr] of attrs.entries()) {
    const size = formatByteSize(attr.format);
    if (attr.offset + size > stride)
      throw meshLayoutInvalidError(where, `Attribute '${metas[i]?.name}' (${attr.offset}+${size}) exceeds stride ${stride}.`);
  }
  const bytes = opts.data ? byteLength(opts.data) : void 0;
  if (bytes !== void 0 && bytes % stride !== 0)
    throw meshDataMisalignedError(where, `Data byteLength ${bytes} is not divisible by stride ${stride}.`);
  const owned = opts.data !== void 0 ? device.createBuffer({ label: opts.label, size: Math.max(4, bytes ?? 0), usage: ["vertex", "copy_dst"] }) : void 0;
  if (owned && opts.data)
    owned.write(opts.data);
  const layout = Object.freeze({ arrayStride: stride, ...opts.stepMode ? { stepMode } : {}, attributes: Object.freeze(attrs) });
  return { layout, attributes: Object.freeze(metas), stride, stepMode, byteLength: bytes, gpu: owned?.gpu ?? requiredBuffer(opts.buffer, where), owned };
}
function normalizeIndex(device, opts, where) {
  if (opts.indices !== void 0 && opts.indexBuffer !== void 0)
    throw meshLayoutInvalidError(where, "Choose indices or indexBuffer, not both.");
  if (opts.indices === void 0) {
    const rawFields = [opts.indexBuffer, opts.indexFormat, opts.indexCount];
    const present = rawFields.filter((value) => value !== void 0).length;
    if (present !== 0 && present !== 3)
      throw meshLayoutInvalidError(where, "Provide indexBuffer, indexFormat, and indexCount together.");
    if (opts.indexFormat !== void 0 && opts.indexFormat !== "uint16" && opts.indexFormat !== "uint32")
      throw meshLayoutInvalidError(where, `Unknown index format '${String(opts.indexFormat)}'.`);
    if (opts.indexCount !== void 0)
      validateRange(where, "indexCount", opts.indexCount, Number.MAX_SAFE_INTEGER);
    return { gpu: opts.indexBuffer, format: opts.indexFormat, count: opts.indexCount };
  }
  if (opts.indexFormat !== void 0)
    throw meshLayoutInvalidError(where, "indices infer format; omit indexFormat.");
  const data = Array.isArray(opts.indices) ? new Uint32Array(opts.indices) : opts.indices;
  const format = data instanceof Uint16Array ? "uint16" : "uint32";
  const bytes = data.byteLength;
  if (bytes % (format === "uint16" ? 2 : 4) !== 0)
    throw meshDataMisalignedError(where, `Index byteLength ${bytes} is invalid for ${format}.`);
  const owned = device.createBuffer({ label: opts.label ? `${opts.label}.indices` : void 0, size: Math.max(4, bytes), usage: ["index", "copy_dst"] });
  owned.write(data);
  return { gpu: owned.gpu, owned, format, count: data.length, byteLength: bytes };
}
function deriveCount(buffers, stepMode) {
  let count;
  for (const buffer of buffers)
    if (buffer.stepMode === stepMode && buffer.byteLength !== void 0)
      count = Math.min(count ?? Infinity, Math.floor(buffer.byteLength / buffer.stride));
  return count;
}
function requireExplicitRawCount(buffers, stepMode, count, where) {
  if (count === void 0 && buffers.some((buffer) => buffer.stepMode === stepMode && buffer.byteLength === void 0))
    throw meshLayoutInvalidError(where, `Raw ${stepMode} buffer needs ${stepMode}Count.`);
}
function validateOptionalCapacity(where, field, value, capacity) {
  if (value === void 0)
    return;
  validateRange(where, field, value, capacity ?? Number.MAX_SAFE_INTEGER);
}
function lockPublicGeometryProperties(geometry2) {
  for (const key of Object.keys(geometry2))
    if (key !== "destroyed")
      Object.defineProperty(geometry2, key, { writable: false, configurable: false });
}
var TOPOLOGIES = /* @__PURE__ */ new Set(["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"]);
function requiredBuffer(buffer, where) {
  if (!buffer)
    throw meshLayoutInvalidError(where, "Provide geometry buffer data or buffer.");
  return buffer;
}
function byteLength(data) {
  return data.byteLength;
}
function roundUp4(n) {
  return n + 3 & ~3;
}
function validateWriteRange(where, capacity, length, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0 || length % 4 !== 0 || offset + length > capacity)
    throw meshWriteRangeError(where, `Write size ${length}/offset ${String(offset)} must be 4-aligned within ${capacity} bytes.`);
}
function validateRange(where, field, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw meshRangeInvalidError(where, `${field}=${String(value)} must be an integer in [0,${max}].`);
}
function vertexFormatBase(format) {
  if (format.startsWith("sint"))
    return "i32";
  if (format.startsWith("uint"))
    return "u32";
  return "f32";
}
function shaderTypeBase(type) {
  if (type.kind === "scalar")
    return type.name;
  if (type.kind === "vector" || type.kind === "matrix" || type.kind === "atomic")
    return shaderTypeBase(type.element);
  return type.kind;
}

// node_modules/@vgpu/wgsl/dist/runtime/errors.js
var VGPUError3 = class extends Error {
  code;
  line;
  column;
  severity;
  metadata;
  relatedDiagnostics;
  /** Actionable remediation text. Forwarded verbatim from the underlying error when there is one. */
  fix;
  /** Coarse origin of the failure (e.g. `"resolveShader"`), mirroring `@vgpu/core`'s `VGPUError`. */
  where;
  cause;
  constructor(code, message, line = 1, column = 1, severity = "error") {
    super(message);
    this.name = "VGPUError";
    this.code = code;
    this.line = line;
    this.column = column;
    this.severity = severity;
  }
};
function wgslErrorWithFix(code, message, data = {}) {
  const error = new VGPUError3(code, message, data.line ?? 1, data.column ?? 1, data.severity ?? "error");
  if (data.fix !== void 0)
    error.fix = data.fix;
  if (data.where !== void 0)
    error.where = data.where;
  if (data.cause !== void 0)
    error.cause = data.cause;
  if (data.metadata !== void 0)
    error.metadata = data.metadata;
  return error;
}
function wgslError(code, message, line = 1, column = 1) {
  return new VGPUError3(code, message, line, column);
}

// node_modules/@vgpu/wgsl/dist/runtime/parser.js
var declKinds = /* @__PURE__ */ new Set(["fn", "struct", "const", "alias", "var", "override"]);
function parseModule(tokens) {
  const imports = [];
  const locals = [];
  const exports = [];
  let i = 0;
  let sawDecl = false;
  let depth = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.text === "{") {
      depth++;
      i++;
      continue;
    }
    if (token.text === "}") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (isComment(token)) {
      i++;
      continue;
    }
    if (depth > 0) {
      i++;
      continue;
    }
    if (token.text === "import") {
      if (sawDecl)
        throw wgslError("VGPU-WGSL-IMP-ORDER", "Imports must precede declarations", token.line, token.column);
      const [decl, next] = parseImport(tokens, i);
      imports.push(decl);
      i = next;
      continue;
    }
    if (token.text === "export" && tokens[i + 1]?.text === "{")
      throw wgslError("VGPU-WGSL-EXP-REEXPORT-CYCLE", "Re-export cycles are not supported", token.line, token.column);
    if (token.text === "@" && tokens[i + 2]?.text === "export" && tokens[i + 3]?.text === "@")
      throw wgslError("VGPU-WGSL-EXP-NOTDECL", "Repeated export attributes", token.line, token.column);
    const exported = token.text === "export" || token.text === "@" && tokens[i + 2]?.text === "export";
    const kindIndex = exported ? skipAttrs(tokens, token.text === "export" ? i + 1 : i + 3) : i;
    const kind = tokens[kindIndex];
    if (kind && declKinds.has(kind.text)) {
      const name = findDeclName(tokens, kindIndex);
      locals.push({ name, localName: name, kind: kind.text });
      if (exported)
        exports.push({ name, localName: name, kind: kind.text });
      sawDecl = true;
      i = kindIndex + 1;
      continue;
    }
    i++;
  }
  return { imports, exports, locals };
}
function parseImport(tokens, start) {
  let i = start + 1;
  const bindings = [];
  if (tokens[i]?.text === "{") {
    i++;
    while (tokens[i] && tokens[i].text !== "}") {
      if (isComment(tokens[i])) {
        i++;
        continue;
      }
      const imported = expectIdent(tokens[i]);
      let local = imported;
      i++;
      if (tokens[i]?.text === "as") {
        local = expectIdent(tokens[i + 1]);
        i += 2;
      }
      bindings.push({ imported, local });
      if (tokens[i]?.text === ",")
        i++;
    }
    i++;
    expectText(tokens[i], "from");
    i++;
  } else if (tokens[i]?.text === "*") {
    expectText(tokens[i + 1], "as");
    bindings.push({ imported: "*", local: expectIdent(tokens[i + 2]), namespace: true });
    i += 3;
    expectText(tokens[i], "from");
    i++;
  } else if (tokens[i]?.kind === "string") {
    throw wgslError("VGPU-WGSL-IMP-SIDEEFFECT", "Side-effect imports are not supported", tokens[i].line, tokens[i].column);
  } else {
    throw wgslError("VGPU-WGSL-IMP-DEFAULT", "Default imports are not supported", tokens[i]?.line, tokens[i]?.column);
  }
  const fromToken = tokens[i];
  if (fromToken?.kind !== "string")
    throw wgslError("VGPU-WGSL-RES-NOTFOUND", "Import path must be a string", fromToken?.line, fromToken?.column);
  const from = fromToken.text.slice(1, -1);
  i++;
  if (tokens[i]?.text === ";")
    i++;
  return [{ from, bindings, start: tokens[start].start, end: tokens[i - 1].end }, i];
}
function skipAttrs(tokens, i) {
  i = skipTrivia(tokens, i);
  while (tokens[i]?.text === "@") {
    const nameIndex = skipTrivia(tokens, i + 1);
    i = skipTrivia(tokens, nameIndex + 1);
    if (tokens[i]?.text === "(") {
      let depth = 0;
      do {
        if (tokens[i]?.text === "(")
          depth++;
        else if (tokens[i]?.text === ")")
          depth--;
        i++;
      } while (tokens[i] && depth > 0);
      i = skipTrivia(tokens, i);
    }
  }
  return i;
}
function skipTrivia(tokens, i) {
  while (tokens[i] && isComment(tokens[i]))
    i++;
  return i;
}
function findDeclName(tokens, kindIndex) {
  let i = kindIndex + 1;
  if (tokens[kindIndex]?.text === "var" && tokens[i]?.text === "<")
    while (tokens[i] && tokens[i].text !== ">")
      i++;
  for (; i < tokens.length; i++)
    if (tokens[i].kind === "ident")
      return tokens[i].text;
  throw wgslError("VGPU-WGSL-EXP-NOTDECL", "Exported declaration has no name", tokens[kindIndex]?.line, tokens[kindIndex]?.column);
}
function expectText(token, text) {
  if (token?.text !== text)
    throw wgslError("VGPU-WGSL-IMP-DEFAULT", `Expected ${text}`, token?.line, token?.column);
}
function expectIdent(token) {
  if (token?.kind !== "ident")
    throw wgslError("VGPU-WGSL-IMP-DEFAULT", "Expected identifier", token?.line, token?.column);
  return token.text;
}
function isComment(token) {
  return token.kind === "lineComment" || token.kind === "blockComment";
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-bind-layout.js
function bindingKind(type, addressSpace) {
  if (addressSpace === "uniform" || addressSpace === "storage")
    return "buffer";
  if (type.kind === "sampler")
    return "sampler";
  if (type.kind === "texture")
    return type.textureKind === "texture_external" ? "externalTexture" : "texture";
  return "unknown";
}
function reflectedBindingLayout(kind, addressSpace, access, type, layout) {
  if (kind === "buffer")
    return reflectedBufferLayout(addressSpace, access, layout);
  if (type.kind === "sampler")
    return reflectedSamplerLayout(type);
  if (type.kind !== "texture")
    return void 0;
  if (type.textureKind === "texture_external")
    return { kind: "externalTexture", externalTexture: {} };
  if (type.textureKind.startsWith("texture_storage_"))
    return reflectedStorageTextureLayout(type);
  return reflectedSampledTextureLayout(type);
}
function reflectedBufferLayout(addressSpace, access, layout) {
  const bufferType = addressSpace === "uniform" ? "uniform" : access === "read" ? "read-only-storage" : "storage";
  return { kind: "buffer", buffer: { type: bufferType, hasDynamicOffset: false, minBindingSize: layout?.size } };
}
function reflectedSamplerLayout(type) {
  return { kind: "sampler", sampler: { type: type.comparison ? "comparison" : "filtering" } };
}
function reflectedStorageTextureLayout(type) {
  return {
    kind: "storageTexture",
    storageTexture: {
      access: storageTextureAccess(type.access),
      format: type.texelFormat ?? "rgba8unorm",
      viewDimension: textureViewDimension(type.dimension)
    }
  };
}
function reflectedSampledTextureLayout(type) {
  return {
    kind: "texture",
    texture: {
      sampleType: textureSampleType(type),
      viewDimension: textureViewDimension(type.dimension),
      multisampled: type.dimension === "multisampled_2d" || type.dimension === "depth_multisampled_2d"
    }
  };
}
function textureSampleType(type) {
  if (type.textureKind.startsWith("texture_depth_"))
    return "depth";
  const sample = type.sampleType;
  if (sample?.kind === "scalar" && sample.name === "i32")
    return "sint";
  if (sample?.kind === "scalar" && sample.name === "u32")
    return "uint";
  return "unfilterable-float";
}
function textureViewDimension(dimension) {
  switch (dimension) {
    case "1d":
      return "1d";
    case "2d_array":
    case "depth_2d_array":
      return "2d-array";
    case "cube":
    case "depth_cube":
      return "cube";
    case "cube_array":
    case "depth_cube_array":
      return "cube-array";
    case "3d":
      return "3d";
    default:
      return "2d";
  }
}
function storageTextureAccess(access) {
  if (access === "read")
    return "read-only";
  if (access === "read_write")
    return "read-write";
  return "write-only";
}

// node_modules/@vgpu/wgsl/dist/runtime/wgsl-identifiers.js
var WGSL_PREDECLARED_TYPES = /* @__PURE__ */ new Set([
  "array",
  "atomic",
  "bool",
  "f16",
  "f32",
  "i32",
  "mat2x2",
  "mat2x3",
  "mat2x4",
  "mat3x2",
  "mat3x3",
  "mat3x4",
  "mat4x2",
  "mat4x3",
  "mat4x4",
  "ptr",
  "sampler",
  "sampler_comparison",
  "texture_1d",
  "texture_2d",
  "texture_2d_array",
  "texture_3d",
  "texture_cube",
  "texture_cube_array",
  "texture_depth_2d",
  "texture_depth_2d_array",
  "texture_depth_cube",
  "texture_depth_cube_array",
  "texture_depth_multisampled_2d",
  "texture_external",
  "texture_multisampled_2d",
  "texture_storage_1d",
  "texture_storage_2d",
  "texture_storage_2d_array",
  "texture_storage_3d",
  "u32",
  "vec2",
  "vec2f",
  "vec2h",
  "vec2i",
  "vec2u",
  "vec3",
  "vec3f",
  "vec3h",
  "vec3i",
  "vec3u",
  "vec4",
  "vec4f",
  "vec4h",
  "vec4i",
  "vec4u"
]);
var WGSL_PREDECLARED_VALUES = /* @__PURE__ */ new Set([
  "abs",
  "acos",
  "acosh",
  "all",
  "any",
  "arrayLength",
  "asin",
  "asinh",
  "atan",
  "atan2",
  "atanh",
  "ceil",
  "clamp",
  "cos",
  "cosh",
  "countLeadingZeros",
  "countOneBits",
  "countTrailingZeros",
  "cross",
  "degrees",
  "determinant",
  "distance",
  "dot",
  "dot4I8Packed",
  "dot4U8Packed",
  "dpdx",
  "dpdxCoarse",
  "dpdxFine",
  "dpdy",
  "dpdyCoarse",
  "dpdyFine",
  "exp",
  "exp2",
  "extractBits",
  "faceForward",
  "firstLeadingBit",
  "firstTrailingBit",
  "floor",
  "fma",
  "fract",
  "frexp",
  "fwidth",
  "fwidthCoarse",
  "fwidthFine",
  "insertBits",
  "inverseSqrt",
  "ldexp",
  "length",
  "log",
  "log2",
  "max",
  "min",
  "mix",
  "modf",
  "normalize",
  "pack2x16float",
  "pack2x16snorm",
  "pack2x16unorm",
  "pack4x8snorm",
  "pack4x8unorm",
  "pack4xI8",
  "pack4xU8",
  "pack4xI8Clamp",
  "pack4xU8Clamp",
  "pow",
  "quantizeToF16",
  "radians",
  "reflect",
  "refract",
  "reverseBits",
  "round",
  "saturate",
  "select",
  "sign",
  "sin",
  "sinh",
  "smoothstep",
  "sqrt",
  "step",
  "storageBarrier",
  "tan",
  "tanh",
  "textureBarrier",
  "textureDimensions",
  "textureGather",
  "textureGatherCompare",
  "textureLoad",
  "textureNumLayers",
  "textureNumLevels",
  "textureNumSamples",
  "textureSample",
  "textureSampleBaseClampToEdge",
  "textureSampleBias",
  "textureSampleCompare",
  "textureSampleCompareLevel",
  "textureSampleGrad",
  "textureSampleLevel",
  "textureStore",
  "transpose",
  "trunc",
  "unpack2x16float",
  "unpack2x16snorm",
  "unpack2x16unorm",
  "unpack4x8snorm",
  "unpack4x8unorm",
  "unpack4xI8",
  "unpack4xU8",
  "workgroupBarrier"
]);
var WGSL_BUILTIN_VALUES = /* @__PURE__ */ new Set([
  "frag_depth",
  "front_facing",
  "global_invocation_id",
  "instance_index",
  "local_invocation_id",
  "local_invocation_index",
  "num_workgroups",
  "position",
  "sample_index",
  "sample_mask",
  "subgroup_invocation_id",
  "subgroup_size",
  "vertex_index",
  "workgroup_id"
]);
var WGSL_ATTRIBUTE_NAMES = /* @__PURE__ */ new Set([
  "align",
  "binding",
  "blend_src",
  "builtin",
  "compute",
  "diagnostic",
  "fragment",
  "group",
  "id",
  "interpolate",
  "invariant",
  "location",
  "must_use",
  "size",
  "vertex",
  "workgroup_size"
]);
var WGSL_ADDRESS_SPACE_NAMES = /* @__PURE__ */ new Set(["function", "private", "storage", "uniform", "workgroup"]);
var WGSL_ACCESS_MODE_NAMES = /* @__PURE__ */ new Set(["read", "read_write", "write"]);
var WGSL_TEXEL_FORMAT_NAMES = /* @__PURE__ */ new Set([
  "bgra8unorm",
  "r32float",
  "r32sint",
  "r32uint",
  "rg32float",
  "rg32sint",
  "rg32uint",
  "rgba16float",
  "rgba16sint",
  "rgba16uint",
  "rgba32float",
  "rgba32sint",
  "rgba32uint",
  "rgba8sint",
  "rgba8snorm",
  "rgba8uint",
  "rgba8unorm"
]);
var WGSL_RENAME_FORBIDDEN_IDENTIFIERS = /* @__PURE__ */ new Set([
  ...WGSL_KEYWORDS,
  ...WGSL_RESERVED_WORDS,
  ...WGSL_LEGACY_RESERVED_WORDS,
  ...WGSL_PREDECLARED_TYPES,
  ...WGSL_PREDECLARED_VALUES,
  ...WGSL_BUILTIN_VALUES,
  ...WGSL_ATTRIBUTE_NAMES,
  ...WGSL_ADDRESS_SPACE_NAMES,
  ...WGSL_ACCESS_MODE_NAMES,
  ...WGSL_TEXEL_FORMAT_NAMES
]);

// node_modules/@vgpu/wgsl/dist/runtime/scanner.js
var NON_ASCII_IDENTIFIER_CODE = "VGPU-WGSL-IDENT-NONASCII";
var XID_ISSUE_URL = "https://github.com/vercel-labs/vgpu/issues/294";
function scan(source, path) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind, start, end, atLine, atColumn) => tokens.push({ kind, text: source.slice(start, end), start, end, line: atLine, column: atColumn });
  const step = () => {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else
      column++;
    i++;
  };
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      step();
      continue;
    }
    const start = i, atLine = line, atColumn = column;
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n")
        step();
      push("lineComment", start, i, atLine, atColumn);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          step();
          step();
          continue;
        }
        if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          step();
          step();
          if (depth === 0) {
            push("blockComment", start, i, atLine, atColumn);
            break;
          }
          continue;
        }
        step();
      }
      if (depth !== 0)
        throw wgslError("VGPU-WGSL-LEX-UNTERM-COMMENT", "Unterminated block comment", atLine, atColumn);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      step();
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\n")
          throw wgslError("VGPU-WGSL-LEX-UNTERM-STRING", "Unterminated string", atLine, atColumn);
        if (source[i] === "\\")
          step();
        step();
      }
      if (i >= source.length)
        throw wgslError("VGPU-WGSL-LEX-UNTERM-STRING", "Unterminated string", atLine, atColumn);
      step();
      push("string", start, i, atLine, atColumn);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]))
        step();
      const text = source.slice(start, i);
      push(WGSL_KEYWORDS.has(text) ? "keyword" : "ident", start, i, atLine, atColumn);
      continue;
    }
    if (/[0-9]/.test(ch) || ch === "." && /[0-9]/.test(source[i + 1] ?? "")) {
      if (ch === ".")
        step();
      while (i < source.length) {
        const current = source[i];
        if (/[A-Za-z0-9_.]/.test(current)) {
          step();
          continue;
        }
        if ((current === "+" || current === "-") && isExponentMarker(source[i - 1]) && /[0-9]/.test(source[i + 1] ?? "")) {
          step();
          continue;
        }
        break;
      }
      push("number", start, i, atLine, atColumn);
      continue;
    }
    if (ch.charCodeAt(0) > 127)
      throw nonAsciiIdentifierError(source, i, line, column, path);
    step();
    push("punct", start, i, atLine, atColumn);
  }
  return tokens;
}
function nonAsciiIdentifierError(source, index, line, column, path) {
  let start = index;
  while (start > 0 && isIdentByte(source[start - 1]))
    start--;
  let end = index + 1;
  while (end < source.length && isIdentByte(source[end]))
    end++;
  const text = source.slice(start, end);
  const atColumn = column - (index - start);
  const where = path === void 0 ? "" : ` in ${path}`;
  const error = wgslErrorWithFix(NON_ASCII_IDENTIFIER_CODE, `Non-ASCII identifier '${text}'${where} at line ${line} column ${atColumn}; vgpu's WGSL pipeline supports ASCII identifiers only`, { fix: `Rename '${text}' using ASCII letters, digits and '_'. Unicode (XID) identifiers are tracked in ${XID_ISSUE_URL}`, line, column: atColumn });
  error.range = { file: path, start: { line, column: atColumn } };
  return error;
}
function isIdentByte(char) {
  return char.charCodeAt(0) > 127 || /[A-Za-z0-9_]/.test(char);
}
function isExponentMarker(char) {
  return char === "e" || char === "E" || char === "p" || char === "P";
}

// node_modules/@vgpu/wgsl/dist/runtime/xxh64.js
var mask = (1n << 64n) - 1n;
var p1 = 11400714785074694791n;
var p2 = 14029467366897019727n;
var p3 = 1609587929392839161n;
var p4 = 9650029242287828579n;
var p5 = 2870177450012600261n;
function xxh64(text, seed = 0n) {
  const input = new TextEncoder().encode(text);
  let index = 0;
  let h;
  if (input.length >= 32) {
    let v1 = seed + p1 + p2, v2 = seed + p2, v3 = seed, v4 = seed - p1;
    const limit = input.length - 32;
    do {
      v1 = round(v1, lane(input, index));
      index += 8;
      v2 = round(v2, lane(input, index));
      index += 8;
      v3 = round(v3, lane(input, index));
      index += 8;
      v4 = round(v4, lane(input, index));
      index += 8;
    } while (index <= limit);
    h = rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n);
    h = merge(h, v1);
    h = merge(h, v2);
    h = merge(h, v3);
    h = merge(h, v4);
  } else
    h = seed + p5;
  h = h + BigInt(input.length) & mask;
  while (index + 8 <= input.length) {
    h ^= round(0n, lane(input, index));
    h = rotl(h, 27n) * p1 + p4 & mask;
    index += 8;
  }
  if (index + 4 <= input.length) {
    h ^= u32(input, index) * p1 & mask;
    h = rotl(h, 23n) * p2 + p3 & mask;
    index += 4;
  }
  while (index < input.length) {
    h ^= BigInt(input[index]) * p5 & mask;
    h = rotl(h, 11n) * p1 & mask;
    index++;
  }
  h ^= h >> 33n;
  h = h * p2 & mask;
  h ^= h >> 29n;
  h = h * p3 & mask;
  h ^= h >> 32n;
  return h.toString(16).padStart(16, "0");
}
function round(acc, laneValue) {
  return rotl(acc + laneValue * p2 & mask, 31n) * p1 & mask;
}
function merge(acc, value) {
  acc ^= round(0n, value);
  return acc * p1 + p4 & mask;
}
function rotl(x, bits) {
  return (x << bits | x >> 64n - bits) & mask;
}
function lane(input, index) {
  let v = 0n;
  for (let i = 7; i >= 0; i--)
    v = (v << 8n) + BigInt(input[index + i]);
  return v;
}
function u32(input, index) {
  return BigInt(input[index]) | BigInt(input[index + 1]) << 8n | BigInt(input[index + 2]) << 16n | BigInt(input[index + 3]) << 24n;
}

// node_modules/@vgpu/wgsl/dist/runtime/mangler.js
function hash64(text) {
  return xxh64(text);
}
function hash8(path) {
  return hash64(path).slice(0, 8);
}
function mangle(path, name) {
  return `_vgsl_${hash8(path)}__${name}`;
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-utils.js
function numericAttr(attrs, name) {
  const attr = attrs.find((item) => item.name === name);
  if (!attr)
    return void 0;
  const text = attr.args.map((token) => token.text).join("");
  const value = Number(text.replace(/[ui]$/, ""));
  return Number.isFinite(value) ? value : void 0;
}
function splitGeneric(tokens) {
  const parts = [[]];
  let angle = 0;
  let paren = 0;
  for (const token of tokens) {
    if (token.text === "<")
      angle++;
    else if (token.text === ">")
      angle = Math.max(0, angle - 1);
    else if (token.text === "(")
      paren++;
    else if (token.text === ")")
      paren = Math.max(0, paren - 1);
    if (token.text === "," && angle === 0 && paren === 0) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1].push(token);
  }
  return parts.map(trim).filter((part) => part.length > 0);
}
function trim(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start].text === ",")
    start++;
  while (end > start && tokens[end - 1].text === ",")
    end--;
  return tokens.slice(start, end);
}
function literalArrayCount(text) {
  if (text === void 0)
    return void 0;
  if (!isLiteralArrayCount(text))
    return void 0;
  return Number(text.replace(/[ui]$/, ""));
}
function isLiteralArrayCount(text) {
  return /^(0|[1-9][0-9]*)([ui])?$/.test(text);
}
function normalizeAccess(value) {
  if (value === "read" || value === "write" || value === "read_write")
    return value;
  return void 0;
}
function scalarName(text) {
  return ["f32", "f16", "i32", "u32", "bool"].find((name) => name === text);
}
function suffixScalar(suffix) {
  return { kind: "scalar", name: suffix === "f" ? "f32" : suffix === "h" ? "f16" : suffix === "i" ? "i32" : "u32" };
}
function scalarSize(name) {
  return name === "f16" ? 2 : 4;
}
function roundUp(align2, value) {
  return Math.ceil(value / align2) * align2;
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-type-parser.js
function parseType(tokens) {
  const trimmed = trim(tokens);
  if (trimmed.length === 0)
    throw wgslError("VGPU-WGSL-REFLECT-TYPE", "Expected WGSL type");
  const text = trimmed.map((token) => token.text).join("");
  const scalar = parseScalarOrShorthandType(text);
  if (scalar)
    return scalar;
  if (trimmed[1]?.text === "<") {
    const head = trimmed[0].text;
    const inner = splitGeneric(trimmed.slice(2, -1));
    const generic = parseGenericType(head, inner);
    if (generic)
      return generic;
  }
  const texture2 = parseTextureIdentifier(text);
  if (texture2)
    return texture2;
  return parseIdentifierType(text);
}
function parseScalarOrShorthandType(text) {
  const scalar = scalarName(text);
  if (scalar)
    return { kind: "scalar", name: scalar };
  const vec = text.match(/^vec([234])([fiuh])$/);
  if (vec)
    return { kind: "vector", width: Number(vec[1]), element: suffixScalar(vec[2]) };
  const mat = text.match(/^mat([234])x([234])([fh])$/);
  if (mat) {
    const element = mat[3] === "h" ? { kind: "scalar", name: "f16" } : { kind: "scalar", name: "f32" };
    return { kind: "matrix", columns: Number(mat[1]), rows: Number(mat[2]), element };
  }
  return void 0;
}
function parseGenericType(head, inner) {
  if (head === "array") {
    const countExpression = inner[1]?.map((t) => t.text).join("");
    const count = countExpression === void 0 ? void 0 : literalArrayCount(countExpression);
    return { kind: "array", element: parseType(inner[0] ?? []), count, countExpression };
  }
  if (head === "atomic")
    return { kind: "atomic", element: parseType(inner[0] ?? []) };
  if (head === "vec2" || head === "vec3" || head === "vec4")
    return { kind: "vector", width: Number(head.slice(3)), element: parseType(inner[0] ?? []) };
  if (/^mat[234]x[234]$/.test(head))
    return { kind: "matrix", columns: Number(head[3]), rows: Number(head[5]), element: parseType(inner[0] ?? []) };
  if (head === "ptr")
    return { kind: "ptr", addressSpace: inner[0]?.map((t) => t.text).join("") ?? "", element: parseType(inner[1] ?? []), access: inner[2]?.map((t) => t.text).join("") };
  if (head === "sampler")
    return { kind: "sampler", comparison: false };
  if (head.startsWith("texture_storage_")) {
    return { kind: "texture", textureKind: head, dimension: head.slice("texture_storage_".length), texelFormat: inner[0]?.map((t) => t.text).join(""), access: normalizeAccess(inner[1]?.map((t) => t.text).join("")) };
  }
  if (head.startsWith("texture_")) {
    return { kind: "texture", textureKind: head, dimension: head.slice("texture_".length), sampleType: inner[0] ? parseType(inner[0]) : void 0 };
  }
  return void 0;
}
function parseTextureIdentifier(text) {
  if (text === "sampler" || text === "sampler_comparison")
    return { kind: "sampler", comparison: text === "sampler_comparison" };
  if (text === "texture_external")
    return { kind: "texture", textureKind: text };
  if (text.startsWith("texture_depth_"))
    return { kind: "texture", textureKind: text, dimension: text.slice("texture_".length) };
  if (text.startsWith("texture_"))
    return { kind: "texture", textureKind: text, dimension: text.slice("texture_".length) };
  return void 0;
}
function parseIdentifierType(text) {
  return { kind: "identifier", name: text };
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-token-utils.js
function expectIdent2(token) {
  if (token?.kind !== "ident" && token?.kind !== "keyword") {
    throw wgslError("VGPU-WGSL-REFLECT-PARSE", "Expected identifier", token?.line, token?.column);
  }
  return token.text;
}
function findNext(tokens, start, text) {
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].text === text)
      return i;
  }
  throw wgslError("VGPU-WGSL-REFLECT-PARSE", `Expected ${text}`, tokens[start]?.line, tokens[start]?.column);
}
function findToken(tokens, start, end, text) {
  for (let i = start; i < end; i++) {
    if (tokens[i].text === text)
      return i;
  }
  return void 0;
}
function skipUntil(tokens, start, text) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].text === "{" || tokens[i].text === "(")
      depth++;
    if (tokens[i].text === "}" || tokens[i].text === ")")
      depth = Math.max(0, depth - 1);
    if (depth === 0 && tokens[i].text === text)
      return i;
  }
  return tokens.length;
}
function matching(tokens, open) {
  const start = tokens[open].text;
  const end = start === "(" ? ")" : start === "{" ? "}" : ">";
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === start)
      depth++;
    if (tokens[i].text === end) {
      depth--;
      if (depth === 0)
        return i;
    }
  }
  throw wgslError("VGPU-WGSL-REFLECT-PARSE", `Unclosed ${start}`, tokens[open]?.line, tokens[open]?.column);
}
function readAttrs(tokens, start) {
  const attrs = [];
  let i = start;
  while (tokens[i]?.text === "@") {
    const token = tokens[i];
    const name = expectIdent2(tokens[i + 1]);
    i += 2;
    let args = [];
    if (tokens[i]?.text === "(") {
      const close = matching(tokens, i);
      args = tokens.slice(i + 1, close);
      i = close + 1;
    }
    attrs.push({ name, args, token });
  }
  return [attrs, i];
}
function typeName(type) {
  switch (type.kind) {
    case "scalar":
      return type.name;
    case "identifier":
      return type.name;
    case "vector":
      return `vec${type.width}<${typeName(type.element)}>`;
    case "matrix":
      return `mat${type.columns}x${type.rows}<${typeName(type.element)}>`;
    case "array":
      return `array<${typeName(type.element)}${type.count === void 0 ? "" : `,${type.count}`}>`;
    default:
      return type.kind;
  }
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-entry-points.js
function parseWorkgroupSize(attrs) {
  const attr = attrs.find((item) => item.name === "workgroup_size");
  if (!attr)
    return void 0;
  const values = splitGeneric(attr.args).map((part) => Number(part.map((token) => token.text).join("")));
  return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-vars.js
function parseVarTemplate(tokens, index) {
  if (tokens[index]?.text !== "<")
    return { after: index };
  const close = findNext(tokens, index, ">");
  const parts = splitGeneric(tokens.slice(index + 1, close)).map((part) => part.map((t) => t.text).join(""));
  return { addressSpace: parts[0], access: normalizeAccess(parts[1]), after: close + 1 };
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-declarations.js
function parseDeclarations(module) {
  const structs = [];
  const aliases = [];
  const vars = [];
  const entries = [];
  const overrides = [];
  const features = [];
  const tokens = module.tokens.filter((token) => token.kind !== "lineComment" && token.kind !== "blockComment");
  let i = 0;
  let depth = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.text === "{") {
      depth++;
      i++;
      continue;
    }
    if (token.text === "}") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth > 0) {
      i++;
      continue;
    }
    const start = i;
    let attrs;
    if (tokens[i]?.text === "export") {
      i++;
      [attrs, i] = readAttrs(tokens, i);
    } else {
      [attrs, i] = readAttrs(tokens, i);
      if (tokens[i]?.text === "export")
        i++;
    }
    const kind = tokens[i]?.text;
    if (kind === "enable") {
      if (tokens[i + 1]?.kind === "ident")
        features.push(tokens[i + 1].text);
      i = skipUntil(tokens, i, ";") + 1;
      continue;
    }
    if (kind === "struct") {
      const result = parseStructDecl(module, tokens, i, attrs);
      if (result.item)
        structs.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "alias") {
      const result = parseAliasDecl(module, tokens, i, attrs);
      if (result.item)
        aliases.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "var") {
      const result = parseVarDecl(module, tokens, i, attrs);
      if (result.item)
        vars.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "fn") {
      const result = parseEntryPointDecl(module, tokens, i, attrs, start);
      if (result.item)
        entries.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "override") {
      const result = parseOverrideDecl(tokens, i, attrs);
      if (result.item)
        overrides.push(result.item);
      i = result.next;
      continue;
    }
    i = Math.max(start + 1, i + 1);
  }
  return { structs, aliases, vars, entries, overrides, features };
}
function parseStructDecl(module, tokens, index, attrs) {
  const name = expectIdent2(tokens[index + 1]);
  const open = findNext(tokens, index + 2, "{");
  const close = matching(tokens, open);
  return {
    item: { name, originalName: name, mangledName: mangledDeclName(module, name, "struct"), members: parseMembers(tokens.slice(open + 1, close)), path: module.path },
    next: close + 1
  };
}
function parseAliasDecl(module, tokens, index, attrs) {
  const name = expectIdent2(tokens[index + 1]);
  const eq = findNext(tokens, index + 2, "=");
  const end = skipUntil(tokens, eq + 1, ";");
  return {
    item: { name, originalName: name, mangledName: mangledDeclName(module, name, "alias"), target: parseType(tokens.slice(eq + 1, end)), path: module.path },
    next: end + 1
  };
}
function parseVarDecl(module, tokens, index, attrs) {
  const { addressSpace, access, after } = parseVarTemplate(tokens, index + 1);
  const name = expectIdent2(tokens[after]);
  const colon = findNext(tokens, after + 1, ":");
  const end = skipUntil(tokens, colon + 1, ";");
  return {
    item: { path: module.path, name, mangledName: isBindingVar(attrs) ? name : mangledDeclName(module, name, "var"), attrs, addressSpace, access, type: parseType(tokens.slice(colon + 1, end)) },
    next: end + 1
  };
}
function parseEntryPointDecl(module, tokens, index, attrs, declarationStart = index) {
  const name = expectIdent2(tokens[index + 1]);
  const stage = attrs.find((attr) => attr.name === "vertex" || attr.name === "fragment" || attr.name === "compute")?.name;
  if (!stage)
    return { item: void 0, next: index + 1 };
  const open = findNext(tokens, index + 2, "(");
  const close = matching(tokens, open);
  const bodyOpen = findNext(tokens, close + 1, "{");
  const bodyClose = matching(tokens, bodyOpen);
  return {
    item: {
      name,
      mangledName: name,
      stage,
      workgroupSize: parseWorkgroupSize(attrs),
      path: module.path,
      params: parseEntryPointParams(tokens.slice(open + 1, close)),
      declarationStartToken: tokens[declarationStart],
      declarationEndToken: tokens[bodyClose]
    },
    next: bodyClose + 1
  };
}
function parseEntryPointParams(tokens) {
  const params = [];
  let i = 0;
  while (i < tokens.length) {
    const [attrs, afterAttrs] = readAttrs(tokens, i);
    i = afterAttrs;
    if (!tokens[i] || tokens[i].text === ",") {
      i++;
      continue;
    }
    const name = expectIdent2(tokens[i]);
    const colon = findNext(tokens, i + 1, ":");
    let end = colon + 1;
    let angle = 0;
    while (end < tokens.length) {
      if (tokens[end].text === "<")
        angle++;
      if (tokens[end].text === ">")
        angle = Math.max(0, angle - 1);
      if (angle === 0 && tokens[end].text === ",")
        break;
      end++;
    }
    params.push({ name, attrs, type: parseType(tokens.slice(colon + 1, end)) });
    i = end + 1;
  }
  return params;
}
function parseOverrideDecl(tokens, index, attrs) {
  const name = expectIdent2(tokens[index + 1]);
  const end = skipUntil(tokens, index + 1, ";");
  const eq = findToken(tokens, index + 2, end, "=");
  return { item: { name, mangledName: name, id: numericAttr(attrs, "id"), defaultValue: eq === void 0 ? void 0 : tokens.slice(eq + 1, end).map((t) => t.text).join("") }, next: end + 1 };
}
function parseMembers(tokens) {
  const members = [];
  let i = 0;
  while (i < tokens.length) {
    const [attrs, afterAttrs] = readAttrs(tokens, i);
    i = afterAttrs;
    if (!tokens[i] || tokens[i].text === "," || tokens[i].text === ";") {
      i++;
      continue;
    }
    const name = expectIdent2(tokens[i]);
    const colon = findNext(tokens, i + 1, ":");
    let end = colon + 1;
    let angle = 0;
    while (end < tokens.length) {
      if (tokens[end].text === "<")
        angle++;
      if (tokens[end].text === ">")
        angle = Math.max(0, angle - 1);
      if (angle === 0 && (tokens[end].text === "," || tokens[end].text === ";"))
        break;
      end++;
    }
    members.push({ name, attrs, type: parseType(tokens.slice(colon + 1, end)), align: numericAttr(attrs, "align"), size: numericAttr(attrs, "size") });
    i = end + 1;
  }
  return members;
}
function mangledDeclName(module, name, kind) {
  return kind === "override" ? name : mangle(module.path, name);
}
function isBindingVar(attrs) {
  return numericAttr(attrs, "group") !== void 0 || numericAttr(attrs, "binding") !== void 0;
}

// node_modules/@vgpu/wgsl/dist/runtime/diagnostics.js
var ARRAY_LENGTH_FIXIT = "literal length required for auto layout; use draw.group(n, bg) manual binding";
var BOOL_HOST_SHAREABLE_FIXIT = "VGPUError: `bool` is not host-shareable in uniform/storage. Fix: use `u32` (0 | 1) \u2192 struct Params { enabled: u32 }";
var MANUAL_GROUP_FIXIT = "use a manual group claim (`draw.group(n, bg)`)";
function arrayLengthError(line = 1, column = 1) {
  return wgslError("VGPU-WGSL-REFLECT-ARRAY-LENGTH", ARRAY_LENGTH_FIXIT, line, column);
}
function boolHostShareableError(line = 1, column = 1) {
  return wgslError("VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE", BOOL_HOST_SHAREABLE_FIXIT, line, column);
}
function unknownTypeError(name, file, line = 1, column = 1) {
  return wgslError("VGPU-WGSL-REFLECT-UNKNOWN-TYPE", `type '${name}' is unknown in ${file}; ${MANUAL_GROUP_FIXIT}`, line, column);
}
function namespaceTypeError(name, file, line = 1, column = 1) {
  return wgslError("VGPU-WGSL-REFLECT-NS-TYPE", `type '${name}' is a namespace-member import; use a named import or manual @group(1+) binding`, line, column);
}
function unsupportedTypeError(name, line = 1, column = 1) {
  return wgslError("VGPU-WGSL-REFLECT-NON-HOST-SHAREABLE", `Type ${name} is not host-shareable; ${MANUAL_GROUP_FIXIT}`, line, column);
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-types.js
var DEFAULT_LAYOUT_MODE = "wgsl-host-shareable-v1";

// node_modules/@vgpu/wgsl/dist/runtime/reflect-symbols.js
function buildModuleSymbols(modules, parsed, resolveImport) {
  const own = /* @__PURE__ */ new Map();
  for (const decls of parsed) {
    const map = /* @__PURE__ */ new Map();
    for (const item of [...decls.structs, ...decls.aliases]) {
      map.set(item.originalName, { path: item.path, name: item.originalName, mangledName: item.mangledName, kind: "members" in item ? "struct" : "alias" });
    }
    own.set(decls.structs[0]?.path ?? decls.aliases[0]?.path ?? decls.vars[0]?.path ?? "", map);
  }
  const byPath = new Map(modules.map((module) => [module.path, own.get(module.path) ?? /* @__PURE__ */ new Map()]));
  const result = /* @__PURE__ */ new Map();
  for (const module of modules) {
    const map = new Map(byPath.get(module.path));
    for (const imp of module.parsed.imports)
      addImportedSymbols(module, imp, map, modules, byPath, resolveImport);
    result.set(module.path, map);
  }
  return result;
}
function addImportedSymbols(module, imp, map, modules, byPath, resolveImport) {
  const targetPath = resolveImportPath(imp, module.path, modules, resolveImport);
  const exports = byPath.get(targetPath);
  for (const binding of imp.bindings) {
    if (binding.namespace) {
      map.set(binding.local, { path: targetPath, name: binding.local, mangledName: binding.local, kind: "namespace" });
      continue;
    }
    const target2 = exports?.get(binding.imported);
    if (target2)
      map.set(binding.local, target2);
  }
}
function buildRegistry(parsed, symbols) {
  const structs = /* @__PURE__ */ new Map();
  const aliases = /* @__PURE__ */ new Map();
  const byMangled = /* @__PURE__ */ new Map();
  const empty = { structs, aliases, byMangled };
  for (const decls of parsed) {
    for (const item of decls.structs) {
      const value = {
        name: item.name,
        mangledName: item.mangledName,
        members: item.members.map((member) => ({ name: member.name, type: resolveType(member.type, item.path, symbols, empty), align: member.align, size: member.size }))
      };
      structs.set(item.mangledName, value);
      byMangled.set(item.mangledName, value);
    }
    for (const item of decls.aliases) {
      const value = { name: item.name, mangledName: item.mangledName, target: resolveType(item.target, item.path, symbols, empty) };
      aliases.set(item.mangledName, value);
      byMangled.set(item.mangledName, value);
    }
  }
  return { structs, aliases, byMangled };
}
function resolveType(type, path, symbols, registry) {
  switch (type.kind) {
    case "identifier": {
      const dot = type.name.indexOf(".");
      if (dot > 0) {
        const ns = type.name.slice(0, dot);
        const target3 = symbols.get(path)?.get(ns);
        if (target3?.kind === "namespace")
          throw namespaceTypeError(type.name, path);
      }
      const target2 = symbols.get(path)?.get(type.name);
      if (target2?.kind === "namespace")
        throw namespaceTypeError(type.name, path);
      if (!target2)
        throw unknownTypeError(type.name, path);
      return { kind: "identifier", name: target2.name, mangledName: target2.mangledName };
    }
    case "array":
    case "atomic":
    case "vector":
    case "matrix":
    case "ptr":
      return { ...type, element: resolveType(type.element, path, symbols, registry) };
    case "texture":
      return { ...type, sampleType: type.sampleType ? resolveType(type.sampleType, path, symbols, registry) : void 0 };
    default:
      return type;
  }
}
function unwrapAlias(type, registry) {
  if (!registry || type.kind !== "identifier")
    return type;
  const alias = registry.aliases.get(type.mangledName ?? type.name);
  return alias ? unwrapAlias(alias.target, registry) : type;
}
function resolveAliasesDeep(type, registry) {
  const unwrapped = unwrapAlias(type, registry);
  switch (unwrapped.kind) {
    case "array":
    case "atomic":
    case "vector":
    case "matrix":
    case "ptr":
      return { ...unwrapped, element: resolveAliasesDeep(unwrapped.element, registry) };
    case "texture":
      return { ...unwrapped, sampleType: unwrapped.sampleType ? resolveAliasesDeep(unwrapped.sampleType, registry) : void 0 };
    default:
      return unwrapped;
  }
}
function resolveImportPath(imp, owner, modules, resolveImport) {
  const resolved = tryResolveImport(imp, owner, resolveImport);
  if (resolved !== void 0 && modules.some((module) => module.path === resolved))
    return resolved;
  const from = imp.from;
  const base = owner.slice(0, owner.lastIndexOf("/") + 1);
  const joined = from.startsWith("/") ? from : normalizeVirtualPath(`${base}${from}`);
  const candidates = [from, joined];
  return candidates.find((candidate) => modules.some((module) => module.path === candidate)) ?? resolved ?? joined;
}
function tryResolveImport(imp, owner, resolveImport) {
  if (!resolveImport)
    return void 0;
  try {
    return resolveImport(owner, imp);
  } catch {
    return void 0;
  }
}
function normalizeVirtualPath(path) {
  const absolute = path.startsWith("/");
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".")
      continue;
    if (part === "..")
      parts.pop();
    else
      parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-layout.js
function layoutOf(type, name = typeName(type), mangledName = name, registry) {
  const resolved = registry ? resolveAliasesDeep(type, registry) : type;
  return layoutResolvedType(resolved, name, mangledName, registry);
}
function layoutResolvedType(type, name, mangledName, registry) {
  switch (type.kind) {
    case "scalar":
      return layoutScalar(type, name, mangledName);
    case "atomic":
      return layoutAtomic(type, name, mangledName);
    case "vector":
      return layoutVector(type, name, mangledName, registry);
    case "matrix":
      return layoutMatrix(type, name, mangledName, registry);
    case "array":
      return layoutArray(type, name, mangledName, registry);
    case "identifier":
      return layoutStruct(type, name, mangledName, registry);
    default:
      throw unsupportedTypeError(typeName(type));
  }
}
function layoutScalar(type, name, mangledName) {
  const size = scalarSize(type.name);
  if (type.name === "bool")
    throw boolHostShareableError();
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: size, size };
}
function layoutAtomic(type, name, mangledName) {
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: 4, size: 4 };
}
function layoutVector(type, name, mangledName, registry) {
  const element = layoutOf(type.element, name, mangledName, registry);
  const scalar = element.size ?? 4;
  const align2 = type.width === 2 ? scalar * 2 : scalar * 4;
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: align2, size: scalar * type.width };
}
function layoutMatrix(type, name, mangledName, registry) {
  const column = { kind: "vector", width: type.rows, element: type.element };
  const columnLayout = layoutOf(column, `${name}[]`, `${mangledName}[]`, registry);
  const stride = roundUp(columnLayout.align, columnLayout.size ?? 0);
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: columnLayout.align, size: stride * type.columns, stride, element: columnLayout };
}
function layoutArray(type, name, mangledName, registry) {
  validateArrayCount(type.countExpression);
  const element = layoutOf(type.element, `${name}[]`, `${mangledName}[]`, registry);
  const stride = roundUp(naturalAlign(type.element, registry), element.size ?? 0);
  return {
    name,
    mangledName,
    layoutMode: DEFAULT_LAYOUT_MODE,
    type,
    align: naturalAlign(type, registry),
    size: type.count === void 0 ? void 0 : stride * type.count,
    stride,
    element,
    runtimeSized: type.count === void 0
  };
}
function validateArrayCount(countExpression) {
  if (countExpression !== void 0 && !isLiteralArrayCount(countExpression)) {
    throw arrayLengthError();
  }
}
function layoutStruct(type, name, mangledName, registry) {
  if (!registry)
    throw unknownTypeError(type.name, "<unknown>");
  const struct = registry.structs.get(type.mangledName ?? type.name);
  if (!struct)
    throw unknownTypeError(type.name, "<unknown>");
  const members = [];
  let offset = 0;
  let maxAlign = 1;
  for (const member of struct.members) {
    const laidOut = layoutStructMember(member, offset, registry);
    members.push(laidOut.member);
    offset = laidOut.offset + (laidOut.member.size ?? 0);
    maxAlign = Math.max(maxAlign, laidOut.member.align);
  }
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: maxAlign, size: roundUp(maxAlign, offset), members };
}
function layoutStructMember(member, currentOffset, registry) {
  const memberLayout = layoutOf(member.type, member.name, member.name, registry);
  const align2 = Math.max(naturalAlign(member.type, registry), member.align ?? 1);
  const size = Math.max(memberLayout.size ?? 0, member.size ?? 0);
  const offset = roundUp(align2, currentOffset);
  return {
    member: { name: member.name, offset, align: align2, size, type: member.type, layout: memberLayout, explicitAlign: member.align, explicitSize: member.size },
    offset
  };
}
function naturalAlign(type, registry) {
  const resolved = registry ? resolveAliasesDeep(type, registry) : type;
  switch (resolved.kind) {
    case "scalar":
      return naturalScalarAlign(resolved.name);
    case "atomic":
      return 4;
    case "vector":
      return resolved.width === 2 ? naturalAlign(resolved.element, registry) * 2 : naturalAlign(resolved.element, registry) * 4;
    case "matrix":
      return naturalAlign({ kind: "vector", width: resolved.rows, element: resolved.element }, registry);
    case "array":
      return naturalAlign(resolved.element, registry);
    case "identifier":
      return naturalStructAlign(resolved, registry);
    default:
      throw unsupportedTypeError(typeName(resolved));
  }
}
function naturalScalarAlign(name) {
  if (name === "bool")
    throw boolHostShareableError();
  return scalarSize(name);
}
function naturalStructAlign(type, registry) {
  const struct = registry?.structs.get(type.mangledName ?? type.name);
  if (!struct)
    throw unknownTypeError(type.name, "<unknown>");
  return Math.max(1, ...struct.members.map((member) => Math.max(naturalAlign(member.type, registry), member.align ?? 1)));
}

// node_modules/@vgpu/wgsl/dist/runtime/scope-walker.js
var helperFunctionPattern = /^_vgsl_[0-9a-f]{8,16}__[A-Za-z_][A-Za-z0-9_]*$/;
var topLevelDeclarations = /* @__PURE__ */ new Set(["fn", "struct", "const", "alias", "var", "override"]);
function analyzeWgslTokens(tokens) {
  const walker = new ScopeWalker(tokens);
  return walker.analyze();
}
var ScopeWalker = class {
  tokens;
  scopes = [];
  declarations = [];
  references = [];
  functions = [];
  preserved = /* @__PURE__ */ new Map();
  symbolsByScope = /* @__PURE__ */ new Map();
  moduleFallbackReasons = [];
  pendingSymbols = [];
  moduleScopeId;
  constructor(tokens) {
    this.tokens = tokens;
    this.moduleScopeId = this.createScope("module", void 0, void 0, 0);
  }
  analyze() {
    this.collectTopLevel();
    for (const fn of this.functions)
      this.walkFunction(fn);
    return {
      tokens: this.tokens,
      scopes: this.scopes,
      declarations: this.declarations,
      references: this.references,
      functions: this.functions,
      preservedTokens: [...this.preserved.entries()].map(([tokenIndex, reason]) => ({ tokenIndex, reason })),
      fallback: { wholeModule: this.moduleFallbackReasons.length > 0, reasons: this.moduleFallbackReasons }
    };
  }
  collectTopLevel() {
    let depth = 0;
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (token.text === "{") {
        depth++;
        continue;
      }
      if (token.text === "}") {
        depth--;
        if (depth < 0) {
          this.moduleFallback("unmatched top-level closing brace", i);
          depth = 0;
        }
        continue;
      }
      if (depth !== 0)
        continue;
      if (token.text === "@") {
        i = this.preserveAttribute(i);
        continue;
      }
      if (token.text === "enable" || token.text === "requires" || token.text === "diagnostic" || token.text === "const_assert") {
        i = this.preserveStatement(i, "directive");
        continue;
      }
      if (token.text === "export")
        continue;
      if (token.text === "struct") {
        i = this.collectStruct(i);
        continue;
      }
      if (token.text === "fn") {
        i = this.collectFunction(i);
        continue;
      }
      if (token.text === "const" || token.text === "alias" || token.text === "var" || token.text === "override") {
        i = this.preserveGlobalDeclaration(i);
        continue;
      }
      if (token.kind === "keyword" && !topLevelDeclarations.has(token.text))
        this.moduleFallback(`unexpected top-level keyword '${token.text}'`, i);
    }
    if (depth !== 0)
      this.moduleFallback("unclosed top-level brace", this.tokens.length - 1);
    this.scopes[this.moduleScopeId].endToken = Math.max(0, this.tokens.length - 1);
  }
  collectStruct(index) {
    const name = this.nextSig(index);
    if (name === void 0 || this.tokens[name]?.kind !== "ident") {
      this.moduleFallback("struct without name", index);
      return index;
    }
    this.preserveToken(name, "global");
    const open = this.nextSig(name);
    if (open === void 0 || this.tokens[open]?.text !== "{") {
      this.moduleFallback("struct without body", index);
      return name;
    }
    const close = this.findMatching(open, "{", "}");
    if (close === void 0) {
      this.moduleFallback("unclosed struct body", open);
      return open;
    }
    for (let i = open; i <= close; i++)
      if (this.tokens[i]?.kind === "ident")
        this.preserveToken(i, "struct");
    return close;
  }
  collectFunction(index) {
    const nameIndex = this.nextSig(index);
    if (nameIndex === void 0 || this.tokens[nameIndex]?.kind !== "ident") {
      this.moduleFallback("function without name", index);
      return index;
    }
    const name = this.tokens[nameIndex].text;
    const safeHelper = helperFunctionPattern.test(name) && !this.hasEntryAttributeBefore(index);
    const declId = this.addDeclaration(name, "function", nameIndex, this.moduleScopeId, void 0, safeHelper);
    if (!safeHelper)
      this.preserveToken(nameIndex, "global");
    const paramsOpen = this.nextSig(nameIndex);
    if (paramsOpen === void 0 || this.tokens[paramsOpen]?.text !== "(") {
      this.moduleFallback("function without parameter list", nameIndex);
      return nameIndex;
    }
    const paramsClose = this.findMatching(paramsOpen, "(", ")");
    if (paramsClose === void 0) {
      this.moduleFallback("unclosed function parameter list", paramsOpen);
      return paramsOpen;
    }
    const bodyOpen = this.findNextText(paramsClose + 1, "{");
    if (bodyOpen === void 0) {
      this.moduleFallback("function without body", paramsClose);
      return paramsClose;
    }
    this.preserveFunctionSignatureTail(paramsClose + 1, bodyOpen);
    const bodyClose = this.findMatching(bodyOpen, "{", "}");
    if (bodyClose === void 0) {
      this.moduleFallback("unclosed function body", bodyOpen);
      return bodyOpen;
    }
    const fnScopeId = this.createScope("function", this.moduleScopeId, this.functions.length, paramsOpen);
    this.functions.push({ id: this.functions.length, name, nameTokenIndex: nameIndex, scopeId: fnScopeId, bodyStartToken: bodyOpen, bodyEndToken: bodyClose, skipped: false, fallbackReasons: [] });
    this.collectParams(paramsOpen, paramsClose, fnScopeId, this.functions.length - 1);
    this.scopes[fnScopeId].endToken = bodyClose;
    return bodyClose;
  }
  collectParams(open, close, scopeId, functionId) {
    for (let i = open + 1; i < close; i++) {
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (token.text === "@") {
        i = this.preserveAttribute(i);
        continue;
      }
      if (token.kind === "ident" && this.nextSig(i) !== void 0 && this.tokens[this.nextSig(i)]?.text === ":") {
        this.addDeclaration(token.text, "param", i, scopeId, functionId, true);
        const colon = this.nextSig(i);
        i = this.preserveTypeFrom(colon + 1, [",", ")"], close);
      }
    }
  }
  preserveFunctionSignatureTail(start, bodyOpen) {
    for (let i = start; i < bodyOpen; i++) {
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (token.text === "@") {
        i = this.preserveAttribute(i);
        continue;
      }
      if (token.kind === "ident")
        this.preserveToken(i, "type");
    }
  }
  preserveGlobalDeclaration(index) {
    let i = index + 1;
    if (this.tokens[index]?.text === "var") {
      const next = this.nextSig(index);
      if (next !== void 0 && this.tokens[next]?.text === "<") {
        const end2 = this.findMatching(next, "<", ">");
        if (end2 === void 0) {
          this.moduleFallback("unparseable top-level var template", next);
          return next;
        }
        this.preserveRange(next, end2, "type");
        i = end2 + 1;
      }
    }
    const name = this.findNextIdent(i);
    if (name !== void 0) {
      this.preserveToken(name, "global");
      this.addDeclaration(this.tokens[name].text, "global", name, this.moduleScopeId, void 0, false);
    }
    const end = this.findStatementEnd(index);
    for (let j = index; j <= end; j++)
      if (this.tokens[j]?.kind === "ident")
        this.preserveToken(j, "global");
    return end;
  }
  walkFunction(fn) {
    const scopeStack = [this.moduleScopeId, fn.scopeId];
    const forStates = [];
    const pushScope = (kind, start) => {
      const id = this.createScope(kind, scopeStack[scopeStack.length - 1], fn.id, start);
      scopeStack.push(id);
      return id;
    };
    const popScope = (end) => {
      if (scopeStack.length <= 2) {
        this.functionFallback(fn, "scope frame underflow", end);
        return void 0;
      }
      const id = scopeStack.pop();
      this.scopes[id].endToken = end;
      return id;
    };
    pushScope("block", fn.bodyStartToken);
    let blockDepth = 1;
    for (let i = fn.bodyStartToken + 1; i < fn.bodyEndToken; i++) {
      this.activatePendingSymbols(i);
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (token.text === "@") {
        i = this.preserveAttribute(i);
        continue;
      }
      if (token.text === ".") {
        const member = this.nextSig(i);
        if (member !== void 0 && this.tokens[member]?.kind === "ident")
          this.preserveToken(member, "member");
        continue;
      }
      if (token.text === "enable" || token.text === "requires" || token.text === "diagnostic") {
        i = this.preserveStatement(i, "directive");
        continue;
      }
      if (token.text === "for") {
        const forScopeId = pushScope("for-init", i);
        const paren = this.nextSig(i);
        if (paren === void 0 || this.tokens[paren]?.text !== "(")
          this.functionFallback(fn, "for without parenthesized header", i);
        forStates.push({ scopeId: forScopeId, headerDepth: 0, awaitingBody: false });
        continue;
      }
      const currentFor = forStates[forStates.length - 1];
      if (currentFor && currentFor.bodyDepth === void 0) {
        if (token.text === "(")
          currentFor.headerDepth++;
        if (token.text === ")") {
          currentFor.headerDepth--;
          if (currentFor.headerDepth <= 0)
            currentFor.awaitingBody = true;
        }
      }
      if (token.text === "{") {
        blockDepth++;
        const waitingFor = findLast(forStates, (item) => item.awaitingBody && item.bodyDepth === void 0);
        if (waitingFor)
          waitingFor.bodyDepth = blockDepth;
        pushScope("block", i);
        continue;
      }
      if (token.text === "}") {
        const closedDepth = blockDepth;
        popScope(i);
        blockDepth--;
        while (forStates.length > 0 && forStates[forStates.length - 1].bodyDepth === closedDepth) {
          popScope(i);
          forStates.pop();
        }
        if (blockDepth < 0)
          this.functionFallback(fn, "unmatched closing brace", i);
        continue;
      }
      if (token.text === ":") {
        i = this.preserveTypeFrom(i + 1, ["=", ";", ",", ")", "{"], fn.bodyEndToken);
        continue;
      }
      if (token.text === "-" && this.tokens[this.nextSig(i) ?? -1]?.text === ">") {
        i = this.preserveTypeFrom((this.nextSig(i) ?? i) + 1, ["{"], fn.bodyEndToken);
        continue;
      }
      if (token.text === "let" || token.text === "const" || token.text === "var") {
        i = this.collectLocalDeclaration(i, scopeStack[scopeStack.length - 1], fn);
        continue;
      }
      if (token.kind === "ident" && !this.preserved.has(i)) {
        const declId = this.resolve(token.text, scopeStack);
        if (declId !== void 0)
          this.references.push({ name: token.text, tokenIndex: i, declarationId: declId, scopeId: scopeStack[scopeStack.length - 1], functionId: fn.id });
        else
          this.preserveToken(i, "unknown");
      }
    }
    while (scopeStack.length > 2)
      popScope(fn.bodyEndToken);
  }
  collectLocalDeclaration(index, scopeId, fn) {
    const kind = this.tokens[index].text;
    let cursor = index + 1;
    if (kind === "var") {
      const next = this.nextSig(index);
      if (next !== void 0 && this.tokens[next]?.text === "<") {
        const end = this.findMatching(next, "<", ">");
        if (end === void 0) {
          this.functionFallback(fn, "unparseable var template", next);
          return next;
        }
        this.preserveRange(next, end, "type");
        cursor = end + 1;
      }
    }
    const nameIndex = this.findNextIdent(cursor);
    if (nameIndex === void 0 || nameIndex >= fn.bodyEndToken) {
      this.functionFallback(fn, `${kind} without identifier`, index);
      return index;
    }
    this.addDeclaration(this.tokens[nameIndex].text, kind, nameIndex, scopeId, fn.id, true, this.findStatementEnd(index));
    const afterName = this.nextSig(nameIndex);
    if (afterName !== void 0 && this.tokens[afterName]?.text === ":")
      return this.preserveTypeFrom(afterName + 1, ["=", ";", ",", ")"], fn.bodyEndToken);
    return nameIndex;
  }
  addDeclaration(name, kind, tokenIndex, scopeId, functionId, safeToRename, activateAfter) {
    const id = this.declarations.length;
    this.declarations.push({ id, name, kind, tokenIndex, scopeId, functionId, safeToRename });
    if (activateAfter !== void 0)
      this.pendingSymbols.push({ name, id, scopeId, activateAfter });
    else
      this.activateSymbol(name, id, scopeId);
    return id;
  }
  activatePendingSymbols(tokenIndex) {
    for (let i = this.pendingSymbols.length - 1; i >= 0; i--) {
      const pending = this.pendingSymbols[i];
      if (pending.activateAfter >= tokenIndex)
        continue;
      this.activateSymbol(pending.name, pending.id, pending.scopeId);
      this.pendingSymbols.splice(i, 1);
    }
  }
  activateSymbol(name, id, scopeId) {
    let symbols = this.symbolsByScope.get(scopeId);
    if (!symbols) {
      symbols = /* @__PURE__ */ new Map();
      this.symbolsByScope.set(scopeId, symbols);
    }
    if (!symbols.has(name))
      symbols.set(name, id);
  }
  resolve(name, scopeStack) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const found = this.symbolsByScope.get(scopeStack[i])?.get(name);
      if (found !== void 0)
        return found;
    }
    return void 0;
  }
  preserveAttribute(index) {
    this.preserveToken(index, "attribute");
    const name = this.nextSig(index);
    if (name === void 0)
      return index;
    this.preserveToken(name, "attribute");
    const next = this.nextSig(name);
    if (next === void 0 || this.tokens[next]?.text !== "(")
      return name;
    const close = this.findMatching(next, "(", ")");
    if (close === void 0) {
      this.preserveRange(next, next, "attribute");
      return next;
    }
    this.preserveRange(next, close, "attribute");
    return close;
  }
  preserveTypeFrom(start, terminators, hardEnd) {
    let angle = 0;
    let paren = 0;
    let bracket = 0;
    let last = start - 1;
    for (let i = start; i < hardEnd; i++) {
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (angle === 0 && paren === 0 && bracket === 0 && terminators.includes(token.text))
        return Math.max(start - 1, i - 1);
      if (token.text === "<")
        angle++;
      else if (token.text === ">")
        angle = Math.max(0, angle - 1);
      else if (token.text === "(")
        paren++;
      else if (token.text === ")") {
        if (paren === 0 && terminators.includes(")"))
          return Math.max(start - 1, i - 1);
        paren = Math.max(0, paren - 1);
      } else if (token.text === "[")
        bracket++;
      else if (token.text === "]")
        bracket = Math.max(0, bracket - 1);
      if (token.kind === "ident")
        this.preserveToken(i, "type");
      last = i;
    }
    return last;
  }
  preserveStatement(index, reason) {
    const end = this.findStatementEnd(index);
    this.preserveRange(index, end, reason);
    return end;
  }
  preserveRange(start, end, reason) {
    for (let i = start; i <= end; i++)
      if (this.tokens[i] && this.tokens[i].kind !== "lineComment" && this.tokens[i].kind !== "blockComment")
        this.preserveToken(i, reason);
  }
  preserveToken(index, reason) {
    if (!this.preserved.has(index))
      this.preserved.set(index, reason);
  }
  createScope(kind, parentId, functionId, startToken) {
    const id = this.scopes.length;
    this.scopes.push({ id, kind, parentId, functionId, startToken });
    return id;
  }
  nextSig(index) {
    for (let i = index + 1; i < this.tokens.length; i++)
      if (!isTrivia(this.tokens[i]))
        return i;
    return void 0;
  }
  findNextIdent(index) {
    for (let i = index; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (token.kind === "ident")
        return i;
      if (token.text !== "@")
        return void 0;
    }
    return void 0;
  }
  findNextText(index, text) {
    for (let i = index; i < this.tokens.length; i++)
      if (!isTrivia(this.tokens[i]) && this.tokens[i].text === text)
        return i;
    return void 0;
  }
  // `<` / `>` are deliberately not tracked here: in a declaration's initializer they are
  // comparison or shift operators, not template brackets, and a net-positive count made this scan
  // overshoot the statement's own `;` (vgpu#251). A WGSL template argument list can never contain
  // `;`, `{` or `}`, so angle depth is not load-bearing for finding a statement end.
  findStatementEnd(index) {
    let paren = 0;
    for (let i = index; i < this.tokens.length; i++) {
      const text = this.tokens[i].text;
      if (text === "(")
        paren++;
      else if (text === ")")
        paren = Math.max(0, paren - 1);
      else if (paren === 0 && (text === ";" || text === "{" || text === "}"))
        return i;
    }
    return this.tokens.length - 1;
  }
  findMatching(openIndex, open, close) {
    let depth = 0;
    for (let i = openIndex; i < this.tokens.length; i++) {
      const text = this.tokens[i].text;
      if (text === open)
        depth++;
      if (text === close) {
        depth--;
        if (depth === 0)
          return i;
      }
    }
    return void 0;
  }
  hasEntryAttributeBefore(fnIndex) {
    for (let i = fnIndex - 1; i >= 0; i--) {
      const token = this.tokens[i];
      if (isTrivia(token))
        continue;
      if (token.text === ")" || token.kind === "ident" || token.text === "@") {
        const text = token.text;
        if (text === "compute" || text === "vertex" || text === "fragment")
          return true;
        continue;
      }
      break;
    }
    return false;
  }
  moduleFallback(reason, tokenIndex) {
    this.moduleFallbackReasons.push(`${reason} at token ${tokenIndex}`);
  }
  functionFallback(fn, reason, tokenIndex) {
    fn.skipped = true;
    fn.fallbackReasons.push(`${reason} at token ${tokenIndex}`);
  }
};
function findLast(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--)
    if (predicate(items[i]))
      return items[i];
  return void 0;
}
function isTrivia(token) {
  return token.kind === "lineComment" || token.kind === "blockComment";
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-sampling.js
var filteringCalls = /* @__PURE__ */ new Set(["textureSample", "textureSampleBias", "textureSampleLevel", "textureSampleGrad", "textureGather", "textureSampleBaseClampToEdge"]);
var comparisonCalls = /* @__PURE__ */ new Set(["textureSampleCompare", "textureSampleCompareLevel", "textureGatherCompare"]);
function entrySamplingPairs(modules, raw, bindings) {
  const result = /* @__PURE__ */ new Map();
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex];
    const decls = raw[moduleIndex];
    const analysis = analyzeWgslTokens(module.tokens);
    const bindingDeclarations = /* @__PURE__ */ new Map();
    for (const variable of decls.vars) {
      const group = numericAttr(variable.attrs, "group"), binding = numericAttr(variable.attrs, "binding");
      const declaration = analysis.declarations.find((item) => item.kind === "global" && item.name === variable.name);
      if (group !== void 0 && binding !== void 0 && declaration)
        bindingDeclarations.set(declaration.id, { group, binding });
    }
    const functionDeclarations = /* @__PURE__ */ new Map();
    for (const declaration of analysis.declarations) {
      if (declaration.kind !== "function")
        continue;
      const fn = analysis.functions.find((item) => item.nameTokenIndex === declaration.tokenIndex);
      if (fn)
        functionDeclarations.set(declaration.id, fn.id);
    }
    for (const entry of decls.entries) {
      const root = analysis.functions.find((fn) => fn.name === entry.name);
      const pairs = [];
      let fallback = analysis.fallback.wholeModule || !root;
      if (!fallback && root)
        fallback = !walk(root.id, /* @__PURE__ */ new Map(), /* @__PURE__ */ new Set(), analysis, bindingDeclarations, functionDeclarations, pairs);
      const used = root ? staticallyUsedBindings(root.id, analysis, bindingDeclarations, functionDeclarations) : bindings.map(ref);
      result.set(entry, fallback ? conservativePairs(bindings, used) : dedupe(pairs));
    }
  }
  return result;
}
function walk(functionId, env, visited, analysis, globals, functions, output) {
  const fn = analysis.functions[functionId];
  if (!fn || fn.skipped)
    return false;
  const key = `${functionId}|${[...env].map(([id, ref2]) => `${id}:${ref2.group}:${ref2.binding}`).join(",")}`;
  if (visited.has(key))
    return true;
  visited.add(key);
  const refs = analysis.references.filter((ref2) => ref2.functionId === functionId);
  const refAt = new Map(refs.map((ref2) => [ref2.tokenIndex, ref2]));
  for (let i = fn.bodyStartToken + 1; i < fn.bodyEndToken; i++) {
    const name = analysis.tokens[i]?.text;
    const mode = filteringCalls.has(name ?? "") ? "filtering" : comparisonCalls.has(name ?? "") ? "comparison" : void 0;
    const reference = refAt.get(i);
    const callee = reference && functions.get(reference.declarationId);
    if (!mode && callee === void 0)
      continue;
    const open = nextSignificant(analysis, i);
    if (open === void 0 || analysis.tokens[open]?.text !== "(")
      continue;
    const ranges = argumentRanges(analysis, open);
    if (!ranges)
      return false;
    const origins = ranges.map(([start, end]) => resolveOrigin(start, end, analysis, globals, env));
    if (mode) {
      const offset = name === "textureGather" && !directOrigin(ranges[0], analysis, globals, env) ? 1 : 0;
      const texture2 = origins[offset], sampler2 = origins[offset + 1];
      if (!texture2 || !sampler2)
        return false;
      output.push({ texture: texture2, sampler: sampler2, mode });
    } else {
      const params = analysis.declarations.filter((decl) => decl.kind === "param" && decl.functionId === callee).sort((a, b) => a.tokenIndex - b.tokenIndex);
      const nextEnv = /* @__PURE__ */ new Map();
      for (let p = 0; p < params.length; p++)
        if (origins[p])
          nextEnv.set(params[p].id, origins[p]);
      if (!walk(callee, nextEnv, visited, analysis, globals, functions, output))
        return false;
    }
  }
  return true;
}
function resolveOrigin(start, end, analysis, globals, env) {
  for (const ref2 of analysis.references) {
    if (ref2.tokenIndex < start || ref2.tokenIndex > end)
      continue;
    const origin = globals.get(ref2.declarationId) ?? env.get(ref2.declarationId);
    if (origin)
      return origin;
  }
  return void 0;
}
function directOrigin(range, analysis, globals, env) {
  const first = analysis.references.find((ref2) => ref2.tokenIndex >= range[0] && ref2.tokenIndex <= range[1]);
  return first?.tokenIndex === range[0] ? globals.get(first.declarationId) ?? env.get(first.declarationId) : void 0;
}
function argumentRanges(analysis, open) {
  const ranges = [];
  let paren = 1, bracket = 0, brace = 0, angle = 0, start = open + 1;
  for (let i = open + 1; i < analysis.tokens.length; i++) {
    const text = analysis.tokens[i].text;
    if (text === "(")
      paren++;
    else if (text === ")") {
      paren--;
      if (paren === 0) {
        ranges.push([start, i - 1]);
        return ranges;
      }
    } else if (text === "[")
      bracket++;
    else if (text === "]")
      bracket--;
    else if (text === "{")
      brace++;
    else if (text === "}")
      brace--;
    else if (text === "<")
      angle++;
    else if (text === ">")
      angle--;
    else if (text === "," && paren === 1 && bracket === 0 && brace === 0 && angle === 0) {
      ranges.push([start, i - 1]);
      start = i + 1;
    }
  }
  return void 0;
}
function nextSignificant(analysis, index) {
  for (let i = index + 1; i < analysis.tokens.length; i++)
    if (analysis.tokens[i].kind !== "lineComment" && analysis.tokens[i].kind !== "blockComment")
      return i;
  return void 0;
}
function staticallyUsedBindings(root, analysis, globals, functions) {
  const pending = [root], visited = /* @__PURE__ */ new Set(), used = /* @__PURE__ */ new Map();
  while (pending.length) {
    const functionId = pending.pop();
    if (visited.has(functionId))
      continue;
    visited.add(functionId);
    for (const reference of analysis.references) {
      if (reference.functionId !== functionId)
        continue;
      const binding = globals.get(reference.declarationId);
      if (binding)
        used.set(`${binding.group}:${binding.binding}`, binding);
      const callee = functions.get(reference.declarationId);
      if (callee !== void 0)
        pending.push(callee);
    }
  }
  return [...used.values()];
}
function conservativePairs(bindings, usedBindings) {
  const used = new Set(usedBindings.map((item) => `${item.group}:${item.binding}`));
  const active = bindings.filter((item) => used.has(`${item.group}:${item.binding}`));
  const textures = active.filter((item) => item.bindingLayout?.kind === "texture" && item.bindingLayout.texture.sampleType === "unfilterable-float" && !item.bindingLayout.texture.multisampled);
  const samplers = active.filter((item) => item.bindingLayout?.kind === "sampler" && item.bindingLayout.sampler.type === "filtering");
  return textures.flatMap((texture2) => samplers.map((sampler2) => ({ texture: ref(texture2), sampler: ref(sampler2), mode: "filtering" })));
}
function ref(binding) {
  return { group: binding.group, binding: binding.binding };
}
function dedupe(pairs) {
  const seen = /* @__PURE__ */ new Set();
  return pairs.filter((pair) => {
    const key = `${pair.texture.group}:${pair.texture.binding}:${pair.sampler.group}:${pair.sampler.binding}:${pair.mode}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect.js
function reflect(modules, resolveImport) {
  const raw = modules.map(parseDeclarations);
  const moduleSymbols = buildModuleSymbols(modules, raw, resolveImport);
  const registry = buildRegistry(raw, moduleSymbols);
  const bindings = [];
  const hostShareableLayouts = [];
  for (const decls of raw) {
    for (const variable of decls.vars) {
      const group = numericAttr(variable.attrs, "group");
      const binding = numericAttr(variable.attrs, "binding");
      if (group === void 0 || binding === void 0)
        continue;
      const type = resolveType(variable.type, variable.path, moduleSymbols, registry);
      const kind = bindingKind(type, variable.addressSpace);
      const layout = variable.addressSpace === "uniform" || variable.addressSpace === "storage" ? layoutOf(type, variable.name, variable.mangledName, registry) : void 0;
      if (layout)
        hostShareableLayouts.push(layout);
      bindings.push({
        group,
        binding,
        name: variable.name,
        mangledName: variable.mangledName,
        type,
        kind,
        addressSpace: variable.addressSpace,
        access: variable.access,
        struct: type.kind === "identifier" ? registry.structs.get(type.mangledName ?? type.name) : void 0,
        layout,
        bindingLayout: reflectedBindingLayout(kind, variable.addressSpace, variable.access, type, layout)
      });
    }
  }
  bindings.sort((a, b) => a.group - b.group || a.binding - b.binding);
  const uses = entryBindingUses(modules, raw, bindings);
  const pairs = entrySamplingPairs(modules, raw, bindings);
  return {
    bindings,
    entryPoints: raw.flatMap((item) => item.entries.map((entry) => publicEntryPoint(entry, raw.flatMap((decls) => decls.structs), moduleSymbols, registry, uses.get(entry) ?? bindings, pairs.get(entry) ?? []))),
    overrides: raw.flatMap((item) => item.overrides),
    featuresRequired: [...new Set(raw.flatMap((item) => item.features))],
    aliases: [...registry.aliases.values()],
    structs: [...registry.structs.values()],
    hostShareableLayouts
  };
}
function entryBindingUses(modules, raw, all) {
  const result = /* @__PURE__ */ new Map();
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex];
    const decls = raw[moduleIndex];
    const analysis = analyzeWgslTokens(module.tokens);
    const conservative = analysis.fallback.wholeModule;
    const functionDeclarations = /* @__PURE__ */ new Map();
    for (const declaration of analysis.declarations) {
      if (declaration.kind !== "function")
        continue;
      const fn = analysis.functions.find((item) => item.nameTokenIndex === declaration.tokenIndex);
      if (fn)
        functionDeclarations.set(declaration.id, fn.id);
    }
    const bindingDeclarations = /* @__PURE__ */ new Map();
    for (const variable of decls.vars) {
      const group = numericAttr(variable.attrs, "group");
      const binding = numericAttr(variable.attrs, "binding");
      if (group === void 0 || binding === void 0)
        continue;
      const declaration = analysis.declarations.find((item) => item.kind === "global" && item.name === variable.name);
      if (declaration)
        bindingDeclarations.set(declaration.id, { group, binding });
    }
    for (const entry of decls.entries) {
      const root = analysis.functions.find((fn) => fn.name === entry.name);
      if (conservative || !root) {
        result.set(entry, all);
        continue;
      }
      const pending = [root.id];
      const visited = /* @__PURE__ */ new Set();
      const used = /* @__PURE__ */ new Map();
      while (pending.length) {
        const functionId = pending.pop();
        if (visited.has(functionId))
          continue;
        visited.add(functionId);
        if (!analysis.functions[functionId])
          continue;
        for (const reference of analysis.references) {
          if (reference.functionId !== functionId)
            continue;
          const binding = bindingDeclarations.get(reference.declarationId);
          if (binding)
            used.set(`${binding.group}:${binding.binding}`, binding);
          const callee = functionDeclarations.get(reference.declarationId);
          if (callee !== void 0)
            pending.push(callee);
        }
      }
      result.set(entry, [...used.values()].sort((a, b) => a.group - b.group || a.binding - b.binding));
    }
  }
  return result;
}
function publicEntryPoint(entry, structs, symbols, registry, bindings, samplingPairs) {
  return {
    name: entry.name,
    mangledName: entry.mangledName,
    stage: entry.stage,
    // `workgroupSize` and `inputs` stay absent rather than `undefined`-valued when they do not
    // apply: an own key valued `undefined` survives structuredClone but is dropped by
    // JSON.stringify, which would make the key set differ across serialization boundaries.
    ...entry.workgroupSize ? { workgroupSize: entry.workgroupSize } : {},
    bindings: bindings.map(({ group, binding }) => ({ group, binding })),
    samplingPairs,
    ...entry.stage === "vertex" ? { inputs: vertexInputs(entry, structs, symbols, registry) } : {}
  };
}
function vertexInputs(entry, structs, symbols, registry) {
  const inputs = [];
  for (const param of entry.params) {
    if (hasAttr(param.attrs, "builtin"))
      continue;
    const type = resolveType(param.type, entry.path, symbols, registry);
    const location = numericAttr(param.attrs, "location");
    if (location !== void 0) {
      inputs.push({ name: param.name, location, type });
      continue;
    }
    const unwrapped = unwrapAlias(type, registry);
    if (unwrapped.kind !== "identifier")
      continue;
    const parsed = structs.find((item) => item.mangledName === (unwrapped.mangledName ?? unwrapped.name));
    const reflected = registry.structs.get(unwrapped.mangledName ?? unwrapped.name);
    if (!parsed)
      continue;
    for (let i = 0; i < parsed.members.length; i++) {
      const member = parsed.members[i];
      if (hasAttr(member.attrs, "builtin"))
        continue;
      const memberLocation = numericAttr(member.attrs, "location");
      if (memberLocation === void 0)
        continue;
      inputs.push({ name: member.name, location: memberLocation, type: reflected?.members[i]?.type ?? resolveType(member.type, parsed.path, symbols, registry) });
    }
  }
  return inputs;
}
function hasAttr(attrs, name) {
  return attrs.some((attr) => attr.name === name);
}

// node_modules/@vgpu/wgsl/dist/runtime/reflect-source.js
function reflectSource(wgsl, path = "<runtime>") {
  const tokens = scan(wgsl, path);
  const parsed = parseModule(tokens);
  if (parsed.imports.length > 0) {
    throw wgslError("VGPU-WGSL-REFLECT-SOURCE-IMPORT", "reflectSource() accepts a single raw WGSL string; use resolveShader() for WGSL import graphs.");
  }
  return reflect([{ path, source: wgsl, tokens, parsed }]);
}

// node_modules/vgpu/dist/bind-cache.js
function createBindGroupCache() {
  const entries = /* @__PURE__ */ new Map();
  return {
    getOrCreate(drawId, group, identityTuple, factory) {
      const identities = identityTuple.map(identityKey);
      const key = `${drawId}:${group}:${identities.join("|")}`;
      const existing = entries.get(key);
      if (existing)
        return existing.bindGroup;
      const bindGroup = factory();
      entries.set(key, { identities, bindGroup });
      return bindGroup;
    },
    evictIdentity(identity) {
      const needle = identityKey(identity);
      for (const [key, entry] of entries) {
        if (entry.identities.includes(needle))
          entries.delete(key);
      }
    },
    clearDraw(drawId) {
      const prefix = `${drawId}:`;
      for (const key of entries.keys())
        if (key.startsWith(prefix))
          entries.delete(key);
    },
    dispose() {
      entries.clear();
    }
  };
}
function identityKey(identity) {
  if (typeof identity === "string" || typeof identity === "number")
    return String(identity);
  return `${identity.kind}:${identity.id}`;
}

// node_modules/vgpu/dist/entry-metadata.js
function entryMetadata(entry, field, where) {
  const value = entry[field];
  if (!value) {
    throw new VGPUError2({
      code: "VGPU-REFLECT-ENTRY-METADATA-MISSING",
      message: `Entry point '${entry.name}' has no reflected ${field}.`,
      fix: "Pass the reflection from reflectSource()/resolveShader().",
      where
    });
  }
  return value;
}

// node_modules/vgpu/dist/claim-validation.js
var pendingScopes = /* @__PURE__ */ new WeakMap();
function pushClaimedGroupValidationScope(device, context) {
  if (!device.gpu.pushErrorScope || !device.gpu.popErrorScope)
    return;
  device.gpu.pushErrorScope("validation");
  const pending = pendingScopes.get(device.gpu);
  if (pending)
    pending.push(context);
  else
    pendingScopes.set(device.gpu, [context]);
}
function popLastClaimedGroupValidationScope(device) {
  const pending = pendingScopes.get(device.gpu);
  if (!pending?.length || !device.gpu.popErrorScope)
    return void 0;
  const context = pending.pop();
  if (!pending.length)
    pendingScopes.delete(device.gpu);
  return { context, error: device.gpu.popErrorScope() };
}
function popClaimedGroupValidationScopes(device) {
  const results = [];
  let result = popLastClaimedGroupValidationScope(device);
  while (result) {
    results.push(result);
    result = popLastClaimedGroupValidationScope(device);
  }
  return results;
}
function discardLastClaimedGroupValidationScope(device) {
  const result = popLastClaimedGroupValidationScope(device);
  if (result)
    suppressClaimedGroupValidationResult(result);
}
function discardClaimedGroupValidationScopes(device) {
  for (const result of popClaimedGroupValidationScopes(device))
    suppressClaimedGroupValidationResult(result);
}
function discardClaimedGroupValidationResults(results) {
  for (const result of results)
    suppressClaimedGroupValidationResult(result);
}
function submittedWorkDone(device) {
  return device.gpu.queue.onSubmittedWorkDone?.() ?? Promise.resolve();
}
function claimedGroupValidationDone(device, results = [], opts = {}) {
  return settleClaimedGroupValidations(device, results, opts.errorSink ?? defaultErrorSink);
}
function preferClaimedGroupValidationResult(preferred, fallback) {
  return {
    context: preferred.context,
    error: preferValidationError(preferred.error, fallback.error)
  };
}
async function preferValidationError(preferred, fallback) {
  const results = await Promise.allSettled([preferred, fallback]);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value)
      return result.value;
  }
  const rejection = results.find((result) => result.status === "rejected");
  if (rejection?.status === "rejected")
    throw rejection.reason;
  return null;
}
async function settleClaimedGroupValidations(device, results, errorSink) {
  await submittedWorkDone(device);
  for (const result of results) {
    try {
      const error = await result.error;
      if (error)
        await errorSink(claimedGroupNativeValidationError(result.context.label, result.context.group, error));
    } catch (error) {
      await errorSink(claimedGroupNativeValidationError(result.context.label, result.context.group, error));
    }
  }
}
function suppressClaimedGroupValidationResult(result) {
  void result.error.catch(() => void 0);
}
function defaultErrorSink(error) {
  console.error(error);
}

// node_modules/vgpu/dist/claim-validation-encode.js
function endRenderPassWithClaimValidation(device, pass, validations, fallbackContext) {
  try {
    pass.end();
  } catch (error) {
    const scopes = popClaimedGroupValidationScopes(device);
    discardClaimedGroupValidationResults(validations);
    discardClaimedGroupValidationResults(scopes);
    validations.length = 0;
    const context = scopes[0]?.context ?? fallbackContext;
    if (context)
      throw claimedGroupNativeValidationError(context.label, context.group, error);
    throw error;
  }
}

// node_modules/vgpu/dist/set-resources.js
var nextSyntheticResourceId = 1;
var syntheticIds = /* @__PURE__ */ new WeakMap();
function isPlainValue(value) {
  if (value === null)
    return true;
  if (typeof value !== "object")
    return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Array.isArray(value))
    return true;
  if (value instanceof Buffer || value instanceof Texture)
    return false;
  return !hasAnyResourceShape(value);
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return false;
  if (value instanceof Buffer || value instanceof Texture)
    return false;
  return !hasAnyResourceShape(value);
}
function normalizeResource(binding, value, context) {
  try {
    return normalizeLiveResource(binding, value, context);
  } catch (error) {
    if (error?.code === "VGPU-CORE-TEXTURE-DESTROYED") {
      const label = value instanceof Texture ? value.label : asTarget(value)?.color.label;
      throw destroyedBindingError(context.sourceHint, binding, label);
    }
    throw error;
  }
}
function normalizeLiveResource(binding, value, context) {
  switch (binding.bindingLayout?.kind) {
    case "buffer":
      return normalizeBufferResource(binding, value, context);
    case "texture":
      return normalizeTextureResource(binding, value, context);
    case "sampler":
      return normalizeSamplerResource(binding, value);
    case "storageTexture":
      return normalizeStorageTextureResource(binding, value);
    case "externalTexture":
      throw incompatibleResourceError(binding, "external texture", "Pass a compatible GPUExternalTexture.");
    default:
      throw incompatibleResourceError(binding, "reflected resource", "Fix shader reflection bindingLayout.");
  }
}
function normalizeBufferResource(binding, value, context) {
  const provider = bindingResourceOf(value);
  if (provider)
    return provider[BINDING_RESOURCE](binding, context.sourceHint);
  if (value instanceof Buffer) {
    assertBufferUsable(value, `${context.sourceHint}.set`);
    validateBufferUsage(binding, value.options.usage);
    return { resource: { buffer: value.gpu }, identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isUniformLike(value)) {
    assertBufferUsable(value.buffer, `${context.sourceHint}.set`);
    return { resource: { buffer: value.gpu, offset: 0, size: value.size }, identity: value.buffer.resourceIdentity, unsubscribe: (cb) => value.buffer.onDestroy(cb) };
  }
  if (isGPUBufferBinding(value))
    return { resource: value, identity: syntheticIdentity(value.buffer) };
  if (isRawGPUBuffer(value))
    return { resource: { buffer: value }, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "buffer", `Pass a compatible Buffer/Uniform: ${binding.name}.set({ ${binding.name}: gpu.device.createBuffer(...) }).`);
}
function normalizeTextureResource(binding, value, context) {
  const depthBinding = binding.bindingLayout?.kind === "texture" && binding.bindingLayout.texture.sampleType === "depth";
  const target2 = asTarget(value);
  if (target2) {
    if (depthBinding && !target2.depth)
      throw incompatibleResourceError(binding, "a target with a depth attachment", `Create it with target(gpu, { size, depth: true }) or bind a Texture: set({ ${binding.name}: scene.depth }).`);
    const texture2 = depthBinding ? target2.depth : target2.color;
    validateTextureFilterability(binding, texture2, context);
    const onTexturesRecreated = target2.onTexturesRecreated?.bind(target2);
    return { resourceLabel: texture2.label, resource: texture2.createView(textureViewDescriptor(texture2)), identity: texture2.resourceIdentity, unsubscribe: (cb) => {
      const unsubscribeTarget = target2.onDestroy(cb);
      const unsubscribeTexture = texture2.onDestroy(cb);
      return () => {
        unsubscribeTarget();
        unsubscribeTexture();
      };
    }, onRecreate: onTexturesRecreated ? (cb) => onTexturesRecreated(cb) : void 0 };
  }
  if (value instanceof Texture) {
    validateTextureUsage(binding, value.usage);
    validateTextureFilterability(binding, value, context);
    return { resourceLabel: value.label, resource: value.createView(textureViewDescriptor(value)), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isTextureLike(value))
    return { resource: value.createView(), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (typeof value === "object" && value !== null)
    return { resource: value, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "texture/target", `Pass a Texture or Target: ${binding.name}.set({ ${binding.name}: scene.color }) or set({ ${binding.name}: scene }).`);
}
function normalizeStorageTextureResource(binding, value) {
  const layout = binding.bindingLayout?.kind === "storageTexture" ? binding.bindingLayout.storageTexture : void 0;
  const expected = { format: layout?.format, viewDimension: layout?.viewDimension ?? "2d" };
  const create = `texture(gpu, { kind: "${expected.viewDimension}", size${expected.viewDimension === "2d-array" ? ", layers" : ""}, format: "${expected.format ?? "rgba8unorm"}", usage: ["storage_binding"] })`;
  if (asTarget(value))
    throw incompatibleResourceError(binding, "a storage texture, not a Target", `Render targets are not storage textures. Create one with ${create} and set({ ${binding.name}: texture }).`);
  if (value instanceof Texture) {
    validateStorageTexture(binding, value, expected, create);
    return { resourceLabel: value.label, resource: value.createView(storageViewDescriptor(expected.viewDimension)), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isTextureLike(value))
    return { resource: value.createView(storageViewDescriptor(expected.viewDimension)), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (typeof value === "object" && value !== null)
    return { resource: value, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "a storage texture", `Pass a Texture from ${create}: set({ ${binding.name}: texture }).`);
}
function validateStorageTexture(binding, texture2, expected, create) {
  const name = texture2.label ?? "texture";
  if (!texture2.usage.includes("storage_binding"))
    throw incompatibleResourceError(binding, "a texture with storage_binding usage", `Create it with ${create}; include texture_binding too if you also sample it.`);
  if (expected.format && texture2.format !== expected.format) {
    throw incompatibleResourceError(binding, `format ${expected.format}`, `Texture '${name}' is ${texture2.format}. Create it with ${create} or declare texture_storage_${expected.viewDimension.replace("-", "_")}<${texture2.format}, ...> in WGSL.`);
  }
  const dimension = textureDimensionFor(expected.viewDimension);
  if (dimension && texture2.dimension !== dimension)
    throw incompatibleResourceError(binding, `dimension "${dimension}"`, `Texture '${name}' has kind "${texture2.kind}". Create it with ${create}.`);
}
function storageViewDescriptor(dimension) {
  return { dimension, baseMipLevel: 0, mipLevelCount: 1 };
}
function textureDimensionFor(viewDimension) {
  switch (viewDimension) {
    case "1d":
      return "1d";
    case "2d":
    case "2d-array":
      return "2d";
    case "3d":
      return "3d";
    default:
      return void 0;
  }
}
function normalizeSamplerResource(binding, value) {
  if (isSamplerLike(value))
    return { resource: value, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "sampler", `Use the cached sampler: set({ ${binding.name}: sampler(gpu) }).`);
}
function isSamplerLike(value) {
  if (typeof value !== "object" || value === null)
    return false;
  if (value instanceof Buffer || value instanceof Texture)
    return false;
  return !isRawGPUBuffer(value) && !isGPUBufferBinding(value) && !isTextureLike(value) && !asTarget(value);
}
function validateBufferUsage(binding, usage) {
  const expected = binding.bindingLayout?.kind === "buffer" ? binding.bindingLayout.buffer.type : void 0;
  if (expected === "uniform" && !usage.includes("uniform"))
    throw incompatibleResourceError(binding, "uniform buffer", "Create with usage: ['uniform','copy_dst'].");
  if ((expected === "storage" || expected === "read-only-storage") && !usage.includes("storage"))
    throw incompatibleResourceError(binding, "storage buffer", "Create with usage: ['storage','copy_dst'].");
}
function validateTextureUsage(binding, usage) {
  if (!usage.includes("texture_binding") && !usage.includes("render_attachment")) {
    throw incompatibleResourceError(binding, "sampled texture", "Use texture_binding usage or a sampleable Target.");
  }
}
function validateTextureFilterability(binding, texture2, context) {
  if (!context.filterableTexture || context.float32Filterable)
    return;
  if (texture2.format === "r32float" || texture2.format === "rg32float" || texture2.format === "rgba32float") {
    throw textureFilterabilityError(context.sourceHint, binding, texture2.format, texture2.label ?? "texture", context.pairedSampler);
  }
}
function textureViewDescriptor(texture2) {
  return texture2.format.includes("stencil") ? { aspect: "depth-only" } : void 0;
}
function asTarget(value) {
  if (typeof value !== "object" || value === null)
    return void 0;
  const record = value;
  if (!record.resourceIdentity || !record.color || typeof record.onDestroy !== "function")
    return void 0;
  return record;
}
function hasAnyResourceShape(value) {
  const record = value;
  return "gpu" in record || "bindGroup" in record || "createView" in record || "resourceIdentity" in record;
}
function syntheticIdentity(value) {
  if (typeof value !== "object" || value === null)
    return `value:${String(value)}`;
  let id = syntheticIds.get(value);
  if (!id) {
    id = { kind: "external", id: nextSyntheticResourceId++ };
    syntheticIds.set(value, id);
  }
  return id;
}
function isUniformLike(value) {
  return typeof value === "object" && value !== null && "gpu" in value && "size" in value && "buffer" in value && value.buffer instanceof Buffer;
}
function isTextureLike(value) {
  return typeof value === "object" && value !== null && typeof value.createView === "function";
}
function isGPUBufferBinding(value) {
  return typeof value === "object" && value !== null && "buffer" in value && isRawGPUBuffer(value.buffer);
}
function isRawGPUBuffer(value) {
  return typeof value === "object" && value !== null && "size" in value && "usage" in value && typeof value.destroy === "function";
}

// node_modules/vgpu/dist/set-packing.js
function writeLayoutValue(layout, value) {
  ensureStaticLayoutSize(layout);
  validateValue(layout, value, "$", 0, layout.size);
  const bytes = new ArrayBuffer(layout.size);
  writeValue(new DataView(bytes), layout, 0, value);
  return bytes;
}
function ensureStaticLayoutSize(layout) {
  if (layout.size === void 0)
    throw unsupportedError("set", `No se puede inferir byteLength para layout runtime-sized '${layout.name}'.`);
}
function writeValue(view, layout, offset, value) {
  if (layout.members)
    return writeStruct(view, layout.members, offset, value);
  writeLeafValue(view, layout, offset, value);
}
function writeStruct(view, members, base, value) {
  const object = value;
  for (const member of members)
    writeValue(view, member.layout, base + member.offset, object?.[member.name]);
}
function writeLeafValue(view, layout, offset, value) {
  switch (layout.type.kind) {
    case "scalar":
      return writeScalar(view, offset, layout.type.name, value);
    case "atomic":
      return writeAtomic(view, offset, layout.type, value);
    case "vector":
      return writeVector(view, offset, layout.type, value);
    case "matrix":
      return writeMatrix(view, layout, offset, value);
    case "array":
      return writeArray(view, layout, offset, value);
    default:
      throw unsupportedError("set", `No hay writer para layout ${layout.type.kind}.`);
  }
}
function writeScalar(view, offset, type, value) {
  if (type === "f32")
    view.setFloat32(offset, value, true);
  else if (type === "i32")
    view.setInt32(offset, value, true);
  else if (type === "u32" || type === "bool")
    view.setUint32(offset, type === "bool" ? value ? 1 : 0 : value, true);
  else
    view.setUint16(offset, float32ToFloat16(value), true);
}
function writeAtomic(view, offset, type, value) {
  writeScalar(view, offset, scalarName2(type.element), value);
}
function writeVector(view, offset, type, value) {
  const values = value;
  const stride = scalarByteSize(type.element);
  for (let i = 0; i < type.width; i++)
    writeScalar(view, offset + i * stride, scalarName2(type.element), values?.[i] ?? 0);
}
function writeMatrix(view, layout, offset, value) {
  const matrix = layout.type;
  const values = value;
  const scalar = scalarByteSize(matrix.element);
  const stride = layout.stride ?? 16;
  for (let c = 0; c < matrix.columns; c++)
    for (let r = 0; r < matrix.rows; r++)
      writeScalar(view, offset + c * stride + r * scalar, scalarName2(matrix.element), values?.[c * matrix.rows + r] ?? 0);
}
function writeArray(view, layout, offset, value) {
  const values = value;
  const stride = layout.stride ?? layout.element?.size ?? 0;
  if (!layout.element)
    throw unsupportedError("set", "Array layout sin element layout.");
  for (let i = 0; i < values.length; i++)
    writeValue(view, layout.element, offset + i * stride, values[i]);
}
function validateValue(layout, value, path, offset, byteLength2) {
  if (layout.members) {
    validateStruct(layout.members, value, path, offset, byteLength2);
    return;
  }
  switch (layout.type.kind) {
    case "scalar":
      validateScalar(layout.type.name, value, path);
      validateRange2(path, offset, scalarByteSize(layout.type), byteLength2);
      return;
    case "atomic":
      validateScalar(scalarName2(layout.type.element), value, path);
      validateRange2(path, offset, 4, byteLength2);
      return;
    case "vector":
      validateVector(layout.type, value, path, offset, byteLength2);
      return;
    case "matrix":
      validateMatrix(layout, value, path, offset, byteLength2);
      return;
    case "array":
      validateArray(layout, value, path, offset, byteLength2);
      return;
    default:
      throw unsupportedError("set", `No hay validator para layout ${layout.type.kind}.`);
  }
}
function validateStruct(members, value, path, base, byteLength2) {
  if (!isPlainRecord(value))
    throwPacking("type", path, "an object", valueKind(value));
  const declared = new Set(members.map((member) => member.name));
  const unknown = Object.keys(value).find((name) => !declared.has(name));
  if (unknown !== void 0)
    throwPacking("unknown-field", `${path}.${unknown}`, "a declared field", unknown);
  for (const member of members) {
    const memberPath = `${path}.${member.name}`;
    if (!Object.hasOwn(value, member.name))
      throwPacking("missing-field", memberPath, "a required field", "missing");
    validateValue(member.layout, value[member.name], memberPath, base + member.offset, byteLength2);
  }
}
function validateVector(type, value, path, offset, byteLength2) {
  const values = exactArrayLike(value, path, type.width);
  const scalar = scalarName2(type.element);
  const stride = scalarByteSize(type.element);
  for (let index = 0; index < type.width; index++) {
    validateScalar(scalar, values[index], `${path}[${index}]`);
    validateRange2(`${path}[${index}]`, offset + index * stride, stride, byteLength2);
  }
}
function validateMatrix(layout, value, path, offset, byteLength2) {
  const matrix = layout.type;
  const expected = matrix.columns * matrix.rows;
  const values = exactArrayLike(value, path, expected);
  const scalar = scalarName2(matrix.element);
  const scalarSize2 = scalarByteSize(matrix.element);
  const stride = layout.stride;
  if (stride === void 0)
    throw unsupportedError("set", `Matrix layout '${layout.name}' sin stride.`);
  for (let column = 0; column < matrix.columns; column++) {
    for (let row = 0; row < matrix.rows; row++) {
      const index = column * matrix.rows + row;
      const elementPath = `${path}[${column}][${row}]`;
      validateScalar(scalar, values[index], elementPath);
      validateRange2(elementPath, offset + column * stride + row * scalarSize2, scalarSize2, byteLength2);
    }
  }
}
function validateArray(layout, value, path, offset, byteLength2) {
  const values = arrayLike(value, path);
  const arrayType = layout.type;
  if (arrayType.count !== void 0 && values.length !== arrayType.count) {
    throwPacking("shape", path, arrayType.count, values.length);
  }
  const stride = layout.stride;
  if (stride === void 0 || !layout.element)
    throw unsupportedError("set", `Array layout '${layout.name}' sin stride o element layout.`);
  if (layout.runtimeSized) {
    const expected = checkedExtent(stride, values.length, path);
    const actual = layout.size ?? byteLength2 - offset;
    if (actual !== expected)
      throwPacking("extent", path, expected, actual);
  }
  for (let index = 0; index < values.length; index++) {
    validateValue(layout.element, values[index], `${path}[${index}]`, offset + index * stride, byteLength2);
  }
}
function validateScalar(type, value, path) {
  if (type === "bool") {
    if (typeof value !== "boolean")
      throwPacking("type", path, "bool", valueKind(value), type);
    return;
  }
  if (typeof value !== "number")
    throwPacking("type", path, type, valueKind(value), type);
  if (type === "i32" && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
    throwPacking("integer-range", path, "an integer in [-2147483648, 2147483647]", String(value), type);
  }
  if (type === "u32" && (!Number.isInteger(value) || value < 0 || value > 4294967295)) {
    throwPacking("integer-range", path, "an integer in [0, 4294967295]", String(value), type);
  }
}
function exactArrayLike(value, path, expected) {
  const values = arrayLike(value, path);
  if (values.length !== expected)
    throwPacking("shape", path, expected, values.length);
  return values;
}
function arrayLike(value, path) {
  if (Array.isArray(value))
    return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView) && "length" in value) {
    return value;
  }
  throwPacking("type", path, "an array or typed array", valueKind(value));
}
function validateRange2(path, offset, size, byteLength2) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > byteLength2 - size) {
    throwPacking("buffer-range", path, `${size} bytes inside ${byteLength2}`, offset);
  }
}
function checkedExtent(stride, count, path) {
  const extent = stride * count;
  if (!Number.isSafeInteger(stride) || stride < 0 || !Number.isSafeInteger(extent)) {
    throwPacking("extent", path, "a safe byte extent", String(extent));
  }
  return extent;
}
function throwPacking(reason, path, expected, actual, type) {
  const message = reason === "shape" ? `expected exactly ${expected} values, received ${actual}` : reason === "missing-field" ? "required field is missing" : reason === "unknown-field" ? `field '${actual}' is not declared by the layout` : reason === "integer-range" ? `${actual} is outside the exact ${type} range` : reason === "extent" ? `runtime extent requires ${expected} bytes, received ${actual}` : reason === "buffer-range" ? `write at byte ${actual} exceeds ${expected}` : `expected ${expected}, received ${actual}`;
  const detail = type === void 0 ? { reason, path, expected, actual } : { reason, path, expected, actual, type };
  throw setValueInvalidError(detail, message);
}
function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function valueKind(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  if (ArrayBuffer.isView(value))
    return value.constructor.name;
  return typeof value;
}
function scalarByteSize(type) {
  return scalarName2(type) === "f16" ? 2 : 4;
}
function scalarName2(type) {
  if (type.kind !== "scalar")
    throw unsupportedError("set", `Expected scalar, got ${type.kind}`);
  return type.name;
}
function float32ToFloat16(value) {
  const float = new Float32Array(1), int = new Uint32Array(float.buffer);
  float[0] = value;
  const x = int[0];
  const sign = x >> 16 & 32768, mantissa = x & 8388607, exponent = x >> 23 & 255;
  if (exponent === 255)
    return sign | (mantissa ? 32256 : 31744);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 31)
    return sign | 31744;
  if (halfExponent <= 0) {
    if (halfExponent < -10)
      return sign;
    return sign | roundRightToNearestEven(mantissa | 8388608, 14 - halfExponent);
  }
  const roundedMantissa = roundRightToNearestEven(mantissa, 13);
  if (roundedMantissa === 1024) {
    const roundedExponent = halfExponent + 1;
    return roundedExponent >= 31 ? sign | 31744 : sign | roundedExponent << 10;
  }
  return sign | halfExponent << 10 | roundedMantissa;
}
function roundRightToNearestEven(value, shift) {
  const truncated = value >>> shift;
  const remainderMask = (1 << shift) - 1;
  const remainder = value & remainderMask;
  const halfway = 1 << shift - 1;
  return remainder > halfway || remainder === halfway && (truncated & 1) === 1 ? truncated + 1 : truncated;
}

// node_modules/vgpu/dist/set-layouts.js
var bindGroupLayoutCaches = /* @__PURE__ */ new WeakMap();
function visibilityForEntries(bindings, entries) {
  const masks = /* @__PURE__ */ new Map();
  const filterable = /* @__PURE__ */ new Set();
  const nonFilteringSamplers = /* @__PURE__ */ new Set();
  const depthTextures = new Set(bindings.filter((binding) => binding.bindingLayout?.kind === "texture" && binding.bindingLayout.texture.sampleType === "depth").map((binding) => `${binding.group}:${binding.binding}`));
  for (const entry of entries) {
    const stage = entry.stage === "vertex" ? 1 : entry.stage === "fragment" ? 2 : 4;
    for (const binding of entryMetadata(entry, "bindings", "visibility")) {
      const key = `${binding.group}:${binding.binding}`;
      masks.set(key, (masks.get(key) ?? 0) | stage);
    }
    for (const pair of entryMetadata(entry, "samplingPairs", "visibility")) {
      if (pair.mode !== "filtering")
        continue;
      const textureKey = `${pair.texture.group}:${pair.texture.binding}`;
      if (depthTextures.has(textureKey))
        nonFilteringSamplers.add(`${pair.sampler.group}:${pair.sampler.binding}`);
      else
        filterable.add(textureKey);
    }
  }
  const policy = (binding) => masks.get(`${binding.group}:${binding.binding}`) ?? 0;
  Object.defineProperty(policy, "filterable", { value: filterable });
  Object.defineProperty(policy, "nonFilteringSamplers", { value: nonFilteringSamplers });
  return policy;
}
function bindGroupLayoutEntriesForGroup(bindings, group, visibility = defaultVisibility) {
  return bindings.flatMap((binding) => {
    if (binding.group !== group)
      return [];
    const mask2 = visibility(binding);
    const key = `${binding.group}:${binding.binding}`;
    return mask2 === 0 ? [] : [{ binding: binding.binding, visibility: mask2, ...layoutEntry(binding, visibility.filterable?.has(key) ?? false, visibility.nonFilteringSamplers?.has(key) ?? false) }];
  });
}
function bindGroupLayoutsForReflection(device, label, reflection, visibility = defaultVisibility) {
  const map = /* @__PURE__ */ new Map();
  const activeGroups = reflection.bindings.filter((binding) => visibility(binding) !== 0).map((binding) => binding.group);
  const maxGroup = Math.max(-1, ...activeGroups);
  for (let group = 0; group <= maxGroup; group++)
    map.set(group, createBindGroupLayout(device, label, reflection, group, visibility));
  return map;
}
function createBindGroupLayout(device, label, reflection, group, visibility = defaultVisibility) {
  return cachedBindGroupLayout(device, `${label}.group${group}.bgl`, bindGroupLayoutEntriesForGroup(reflection.bindings, group, visibility));
}
function cachedBindGroupLayout(device, label, entries) {
  let cache2 = bindGroupLayoutCaches.get(device.gpu);
  if (!cache2) {
    cache2 = /* @__PURE__ */ new Map();
    bindGroupLayoutCaches.set(device.gpu, cache2);
  }
  const key = JSON.stringify(entries);
  const cached = cache2.get(key);
  if (cached)
    return cached;
  const layout = attachBindGroupLayoutMetadata(device.gpu.createBindGroupLayout({ label, entries }), { entries });
  cache2.set(key, layout);
  return layout;
}
function layoutEntry(binding, filterable, nonFilteringSampler) {
  const reflected = binding.bindingLayout;
  if (!reflected)
    throw unsupportedError("bindGroupLayout", `Binding '${binding.name}' does not have a reflected bindingLayout.`);
  if (filterable && reflected.kind === "texture" && reflected.texture.sampleType === "unfilterable-float" && !reflected.texture.multisampled)
    return { texture: { ...reflected.texture, sampleType: "float" } };
  if (nonFilteringSampler && reflected.kind === "sampler" && reflected.sampler.type === "filtering")
    return { sampler: { type: "non-filtering" } };
  return reflectedToWebGPU(reflected);
}
function reflectedToWebGPU(layout) {
  switch (layout.kind) {
    case "buffer":
      return { buffer: { ...layout.buffer } };
    case "sampler":
      return { sampler: { ...layout.sampler } };
    case "texture":
      return { texture: { ...layout.texture } };
    case "storageTexture":
      return { storageTexture: { ...layout.storageTexture } };
    case "externalTexture":
      return { externalTexture: {} };
  }
}
function defaultVisibility(binding) {
  const stages = globalThis.GPUShaderStage;
  const vertex = stages?.VERTEX ?? 1;
  const fragment = stages?.FRAGMENT ?? 2;
  const compute = stages?.COMPUTE ?? 4;
  return binding.kind === "buffer" ? vertex | fragment | compute : fragment | compute;
}

// node_modules/vgpu/dist/set-core.js
function createSetCore(options) {
  const bindings = initializeBindings(options.reflection);
  const groups = [...options.bindGroupLayouts.keys()].sort((a, b) => a - b);
  const claimedGroups = /* @__PURE__ */ new Map();
  function set(values) {
    const changes = [];
    for (const [name, value] of Object.entries(values))
      changes.push(...setNamedValue(name, value));
    return changes;
  }
  function bindingIsActive(state) {
    const layout2 = options.bindGroupLayouts.get(state.info.group);
    return !!layout2 && !!bindGroupLayoutMetadata(layout2)?.entries.some((entry) => entry.binding === state.info.binding);
  }
  function setNamedValue(name, value) {
    const direct = bindings.get(name);
    if (direct)
      return setBinding(direct, name, value);
    const member = findMemberBinding(name, bindings, options.label);
    if (!member)
      throw unsupportedError(`${options.label}.set`, `Binding '${name}' does not exist in '${options.label}'.`);
    return setBindingMember(member, name, value);
  }
  function setBinding(state, name, value) {
    ensureGroupSettable(state.info.group);
    const ownership = ownershipFor(state.info, value);
    assertBindingOwnership(state, name, ownership);
    const before = identityString(state.identity);
    if (ownership === "lib")
      setLibOwned(state, mergeLibValue(state.libValue, value));
    else
      setUserOwned(state, value);
    state.ownership ??= ownership;
    return bindingIsActive(state) ? identityChangeFor(state, before) : [];
  }
  function setBindingMember(state, memberName, value) {
    ensureGroupSettable(state.info.group);
    const ownership = ownershipFor(state.info, value);
    assertBindingOwnership(state, memberName, ownership);
    assertMemberOwnership(state, memberName, ownership);
    if (ownership !== "lib")
      throw unsupportedError(`${options.label}.set`, `Member '${memberName}' needs a JS value; set resource '${state.info.name}' instead.`);
    const before = identityString(state.identity);
    const base = state.libValue ?? zeroLayoutValue(requiredLibLayout(state));
    setLibOwned(state, { ...objectValue(base), [memberName]: value });
    state.ownership ??= ownership;
    state.memberOwnership.set(memberName, ownership);
    return bindingIsActive(state) ? identityChangeFor(state, before) : [];
  }
  function setLibOwned(state, value) {
    const layout2 = requiredLibLayout(state);
    const bytes = writeLayoutValue(layout2, value);
    state.libValue = value;
    if (!state.buffer)
      createLibBuffer(state, layout2.size);
    state.bytes = bytes;
    state.buffer.write(bytes, 0);
  }
  function resourceContext(binding) {
    const entry = bindGroupLayoutMetadata(options.bindGroupLayouts.get(binding.group))?.entries.find((item) => item.binding === binding.binding);
    const pair = options.reflection.entryPoints.flatMap((item) => entryMetadata(item, "samplingPairs", options.label)).find((item) => item.mode === "filtering" && item.texture.group === binding.group && item.texture.binding === binding.binding);
    const pairedSampler = pair && options.reflection.bindings.find((item) => item.group === pair.sampler.group && item.binding === pair.sampler.binding);
    return { sourceHint: options.label, filterableTexture: entry?.texture?.sampleType === "float", float32Filterable: options.device.features.has("float32-filterable"), pairedSampler };
  }
  function setUserOwned(state, value) {
    const normalized = normalizeResource(state.info, value, resourceContext(state.info));
    state.unsubscribe?.();
    state.unsubscribeRecreate?.();
    state.resource = normalized.resource;
    state.identity = normalized.identity;
    state.destroyed = false;
    state.resourceLabel = normalized.resourceLabel;
    state.subscribeDestroy = normalized.unsubscribe;
    state.unsubscribe = normalized.unsubscribe?.(() => invalidateResource(state));
    state.unsubscribeRecreate = normalized.onRecreate?.(() => rebindRecreatedResource(state, value));
  }
  function rebindRecreatedResource(state, value) {
    const beforeIdentity = identityString(state.identity);
    if (state.identity)
      options.cache.evictIdentity(state.identity);
    setUserOwned(state, value);
    if (bindingIsActive(state))
      for (const change of identityChangeFor(state, beforeIdentity))
        options.onIdentityChange?.(change);
  }
  function claimGroup(group, bindGroup, expectedLayout) {
    layout(group);
    validateClaimedGroup(options.label, group, bindGroup, expectedLayout);
    const previousIdentity = claimedGroups.has(group) ? `claimed-group:${group}` : void 0;
    claimedGroups.set(group, bindGroup);
    return previousIdentity;
  }
  function invalidateResource(state) {
    if (state.destroyed)
      return;
    state.destroyed = true;
    if (state.identity)
      options.cache.evictIdentity(state.identity);
    if (bindingIsActive(state) && !claimedGroups.has(state.info.group))
      options.onIdentityChange?.({
        group: state.info.group,
        binding: state.info.binding,
        bindingName: state.info.name,
        bindingKind: state.info.kind,
        previousIdentity: identityString(state.identity),
        newIdentity: `destroyed:${identityString(state.identity)}`
      });
  }
  function assertUsable() {
    for (const state of bindings.values()) {
      if (state.destroyed && bindingIsActive(state) && !claimedGroups.has(state.info.group)) {
        throw destroyedBindingError(options.label, state.info, state.resourceLabel);
      }
    }
  }
  function watchResources(onDestroyed) {
    assertUsable();
    const unsubscribe = [];
    for (const state of bindings.values()) {
      if (!bindingIsActive(state) || claimedGroups.has(state.info.group) || !state.subscribeDestroy)
        continue;
      const previousIdentity = identityString(state.identity);
      const { group, binding, name, kind } = state.info;
      unsubscribe.push(state.subscribeDestroy(() => onDestroyed({
        group,
        binding,
        bindingName: name,
        bindingKind: kind,
        previousIdentity,
        newIdentity: `destroyed:${previousIdentity}`
      })));
    }
    return () => {
      for (const off of unsubscribe.splice(0))
        off();
    };
  }
  function layout(group) {
    const bgl = options.bindGroupLayouts.get(group);
    if (!bgl)
      throw unsupportedError(`${options.label}.layout`, `@group(${group}) does not exist in '${options.label}'.`);
    return bgl;
  }
  function bindGroups() {
    assertUsable();
    return groups.map(bindGroupFor);
  }
  function bindGroupFor(group) {
    const claimed = claimedGroups.get(group);
    if (claimed)
      return { group, bindGroup: claimed, offsets: [], claimValidation: rawClaimValidation(claimed, group) };
    const active = new Set(bindGroupLayoutMetadata(layout(group))?.entries.map((entry) => entry.binding));
    const groupBindings = options.reflection.bindings.filter((binding) => binding.group === group && active.has(binding.binding));
    const entries = bindGroupEntries(groupBindings);
    const identities = identitiesFor(groupBindings);
    const bindGroup = options.cache.getOrCreate(options.drawId, group, identities, () => options.device.gpu.createBindGroup({
      label: `${options.label}.group${group}`,
      layout: layout(group),
      entries
    }));
    return { group, bindGroup, offsets: [] };
  }
  function rawClaimValidation(bindGroup, group) {
    return bindGroupMetadataFor(bindGroup) ? void 0 : { label: options.label, group };
  }
  function bindGroupEntries(groupBindings) {
    return groupBindings.map((binding) => {
      const state = requiredState(binding);
      return { binding: binding.binding, resource: state.resource };
    });
  }
  function identitiesFor(groupBindings) {
    return groupBindings.map((binding) => requiredState(binding).identity);
  }
  function requiredState(binding) {
    const state = bindings.get(binding.name);
    if (!state?.resource || !state.identity)
      throw neverSetError(options.label, binding);
    return state;
  }
  function ensureGroupSettable(group) {
    if (claimedGroups.has(group))
      throw claimedGroupSetError(options.label, group);
  }
  function createLibBuffer(state, size) {
    state.buffer = options.device.createBuffer({ size, usage: ["uniform", "copy_dst"], label: `${options.label}.${state.info.name}` });
    state.resource = { buffer: state.buffer.gpu, offset: 0, size };
    state.identity = state.buffer.resourceIdentity;
    state.unsubscribe = state.buffer.onDestroy(() => options.cache.evictIdentity(state.buffer.resourceIdentity));
  }
  function requiredLibLayout(state) {
    if (state.info.kind !== "buffer" || !state.info.layout?.size)
      throw unsupportedError(`${options.label}.set`, `Binding '${state.info.name}' needs a compatible resource, not JS.`);
    return state.info.layout;
  }
  return {
    assertUsable,
    watchResources,
    get groups() {
      return groups;
    },
    set,
    claimGroup,
    layout,
    bindGroups,
    bindingState(name) {
      const state = bindings.get(name);
      if (!state?.ownership || !state.resource || !state.identity)
        return void 0;
      return { info: state.info, ownership: state.ownership, resource: state.resource, identity: state.identity };
    }
  };
}
function initializeBindings(reflection) {
  return new Map(reflection.bindings.map((binding) => [binding.name, { info: binding, memberOwnership: /* @__PURE__ */ new Map() }]));
}
function findMemberBinding(memberName, bindings, label) {
  let match;
  for (const state of bindings.values()) {
    if (!state.info.layout?.members?.some((member) => member.name === memberName))
      continue;
    if (match)
      throw unsupportedError(`${label}.set`, `Binding member '${memberName}' is ambiguous in '${label}'; set the complete binding.`);
    match = state;
  }
  return match;
}
function ownershipFor(binding, value) {
  return binding.bindingLayout?.kind === "buffer" && isPlainValue(value) ? "lib" : "user";
}
function assertBindingOwnership(state, name, ownership) {
  if (state.ownership && state.ownership !== ownership)
    throw ownershipFlipError(name, state.ownership);
}
function assertMemberOwnership(state, memberName, ownership) {
  const previous = state.memberOwnership.get(memberName);
  if (previous && previous !== ownership)
    throw ownershipFlipError(memberName, previous);
}
function validateClaimedGroup(label, group, bindGroup, expectedLayout) {
  const claimedMetadata = bindGroupMetadataFor(bindGroup);
  if (!claimedMetadata)
    return;
  const expectedMetadata = bindGroupLayoutMetadata(expectedLayout);
  if (!expectedMetadata)
    return;
  const reason = layoutMismatchReason(expectedMetadata.entries, claimedMetadata.layout.entries);
  if (reason)
    throw claimedGroupIncompatibleError(label, group, reason);
}
function layoutMismatchReason(expected, claimed) {
  if (expected.length !== claimed.length)
    return `expected ${expected.length} bindings and received ${claimed.length}`;
  const expectedByBinding = entriesByBinding(expected);
  const claimedByBinding = entriesByBinding(claimed);
  for (const [binding, entry] of expectedByBinding) {
    const claimedEntry = claimedByBinding.get(binding);
    if (!claimedEntry)
      return `missing @binding(${binding})`;
    if (entrySignature(entry) !== entrySignature(claimedEntry))
      return `@binding(${binding}) does not match the reflected layout`;
  }
  return void 0;
}
function entriesByBinding(entries) {
  return new Map(entries.map((entry) => [entry.binding, entry]));
}
function entrySignature(entry) {
  return JSON.stringify({
    binding: entry.binding,
    visibility: entry.visibility,
    buffer: entry.buffer,
    sampler: entry.sampler,
    texture: entry.texture,
    storageTexture: entry.storageTexture,
    externalTexture: entry.externalTexture ? {} : void 0
  });
}
function identityChangeFor(state, previousIdentity) {
  const nextIdentity = identityString(state.identity);
  if (!nextIdentity || previousIdentity === nextIdentity)
    return [];
  return [{
    group: state.info.group,
    binding: state.info.binding,
    bindingName: state.info.name,
    bindingKind: state.info.kind,
    previousIdentity,
    newIdentity: nextIdentity
  }];
}
function identityString(identity) {
  return identity === void 0 ? void 0 : identityKey(identity);
}
function mergeLibValue(previous, value) {
  return isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
}
function objectValue(value) {
  return isPlainObject(value) ? value : {};
}
function zeroLayoutValue(layout) {
  if (layout.members)
    return Object.fromEntries(layout.members.map((member) => [member.name, zeroLayoutValue(member.layout)]));
  switch (layout.type.kind) {
    case "scalar":
    case "atomic":
      return 0;
    case "vector":
      return Array.from({ length: layout.type.width }, () => 0);
    case "matrix":
      return Array.from({ length: layout.type.columns * layout.type.rows }, () => 0);
    case "array": {
      const element = layout.element;
      if (layout.type.count === void 0 || !element)
        return [];
      return Array.from({ length: layout.type.count }, () => zeroLayoutValue(element));
    }
    default:
      return void 0;
  }
}

// node_modules/vgpu/dist/target-utils.js
var DEFAULT_FORMAT = "rgba8unorm";
var BUILT_IN_CLEAR_COLOR = Object.freeze([0, 0, 0, 1]);
function validateClearColor(value, where) {
  const object = value;
  const components = Array.isArray(value) ? value : [object?.r, object?.g, object?.b, object?.a];
  if (components.length !== 4 || !components.every((component) => typeof component === "number" && Number.isFinite(component)))
    throw clearColorInvalidError(where);
  return copyClearColor(value);
}
function copyClearColor(value) {
  const object = value;
  return Array.isArray(value) ? [value[0], value[1], value[2], value[3]] : { r: object.r, g: object.g, b: object.b, a: object.a };
}
function colorSpecsFor(options) {
  return options.colors ?? [{ format: options.format ?? DEFAULT_FORMAT }];
}
function depthFormatFor(options) {
  return options.depth === true ? "depth24plus" : options.depth || void 0;
}
function sampleCountFor(options) {
  const msaa = options.msaa;
  if (msaa === true || msaa === 4)
    return 4;
  if (msaa === void 0 || msaa === false)
    return 1;
  const e = targetSizeRequiredError();
  e.code = "VGPU-TARGET-MSAA-INVALID";
  e.message = `msaa received ${msaa}; WebGPU 1|4; use true`;
  throw e;
}
function validateTargetOptions(options, caps) {
  if (!Array.isArray(options?.size) || options.size.length !== 2 || !Array.from(options.size).every((value) => Number.isSafeInteger(value) && value > 0))
    throw targetSizeRequiredError();
  const depthFormat = depthFormatFor(options);
  if (depthFormat === "stencil8")
    throw targetStencilOnlyDepthError(depthFormat);
  if (sampleCountFor(options) !== 4)
    return;
  for (const spec of colorSpecsFor(options))
    validateMsaaFormat(spec.format, caps);
}
function validateMsaaFormat(format, caps) {
  if (!(caps.isCompatibilityMode && format === "rgba16float"))
    return;
  throw unsupportedError("target", "Dawn compatibility mode does not support rgba16float+msaa.", "Use rgba8unorm for MSAA here, or disable msaa.");
}
function colorAttachment(resolved, msaa, clear, preserve) {
  const attachment = {
    view: (msaa ?? resolved).createView(),
    resolveTarget: msaa ? resolved.createView() : void 0,
    loadOp: preserve ? "load" : "clear",
    storeOp: msaa ? "discard" : "store"
  };
  if (!preserve)
    attachment.clearValue = colorValue(clear);
  return attachment;
}
function depthAttachment(depth, preserve, clearDepth, clearStencil, readOnly) {
  if (readOnly) {
    const attachment2 = { view: depth.createView(), depthReadOnly: true };
    if (hasStencilAspect(depth.format))
      attachment2.stencilReadOnly = true;
    return attachment2;
  }
  const attachment = { view: depth.createView(), depthLoadOp: preserve ? "load" : "clear", depthStoreOp: depth.sampleCount > 1 ? "discard" : "store" };
  if (!preserve)
    attachment.depthClearValue = clearDepth ?? 1;
  if (depth.format && hasStencilAspect(depth.format)) {
    attachment.stencilLoadOp = preserve ? "load" : "clear";
    attachment.stencilStoreOp = depth.sampleCount > 1 ? "discard" : "store";
    if (!preserve)
      attachment.stencilClearValue = clearStencil ?? 0;
  }
  return attachment;
}
function hasStencilAspect(format) {
  return !!format && format.includes("stencil");
}
function colorValue(clear) {
  return Array.isArray(clear) ? { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } : clear;
}
function sameSize(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}
function isTarget(value) {
  return typeof value === "object" && value !== null && typeof value.renderPassDescriptor === "function";
}

// node_modules/vgpu/dist/pipeline-store.js
var nextShaderModuleId = 1;
var nextPipelineLayoutId = 1;
var shaderModuleIds = /* @__PURE__ */ new WeakMap();
var pipelineLayoutIds = /* @__PURE__ */ new WeakMap();
function normalizeSignature(arg) {
  if (isTarget(arg)) {
    return {
      colors: arg.colors.map((color) => color.format),
      depth: arg.depth?.format,
      sampleCount: arg.sampleCount
    };
  }
  if (typeof arg !== "object" || arg === null)
    return { colors: [] };
  return {
    colors: Array.isArray(arg.colors) ? [...arg.colors] : arg.colors ?? [],
    depth: arg.depth,
    sampleCount: arg.sampleCount ?? 1
  };
}
function signatureKeyOf(sig) {
  return `${sig.colors.join(",")}:${sig.depth ?? "none"}:${sig.sampleCount ?? 1}`;
}
function validateTargetSignature(sig, where) {
  if (!Array.isArray(sig.colors) || sig.colors.length === 0)
    throw compileSignatureInvalidError(where, "colors must be a non-empty array.");
  const invalidColor = sig.colors.find((format) => typeof format !== "string" || format.length === 0);
  if (invalidColor !== void 0)
    throw compileSignatureInvalidError(where, `colors must contain only GPUTextureFormat strings; received ${String(invalidColor)}.`);
  if (sig.depth !== void 0 && (typeof sig.depth !== "string" || sig.depth.length === 0))
    throw compileSignatureInvalidError(where, "depth must be a GPUTextureFormat string.");
  const sampleCount = sig.sampleCount ?? 1;
  if (sampleCount !== 1 && sampleCount !== 4)
    throw compileSignatureInvalidError(where, `sampleCount must be 1 or 4; received ${String(sampleCount)}.`);
}
function pipelineKeyOf(parts) {
  const base = `${idFor(shaderModuleIds, parts.module, () => nextShaderModuleId++)}|${idFor(pipelineLayoutIds, parts.pipelineLayout, () => nextPipelineLayoutId++)}|${vertexLayoutHash(parts.vertexBufferLayouts ?? [])}|${signatureKeyOf(parts.signature)}`;
  const primitive = parts.topology || parts.stripIndexFormat ? `${base}|${parts.topology ?? "triangle-list"}|${parts.stripIndexFormat ?? "none"}` : base;
  const culled = parts.cullMode || parts.frontFace ? `${primitive}|${parts.cullMode ?? "none"}|${parts.frontFace ?? "ccw"}` : primitive;
  const clipped = parts.unclippedDepth ? `${culled}|unclipped` : culled;
  const withDepth = parts.depthKey ? `${clipped}|${parts.depthKey}` : clipped;
  const withStencil = parts.stencilKey ? `${withDepth}|${parts.stencilKey}` : withDepth;
  const withMultisample = parts.multisampleKey ? `${withStencil}|${parts.multisampleKey}` : withStencil;
  const withConstants = parts.constantsKey ? `${withMultisample}|${parts.constantsKey}` : withMultisample;
  const withEntry = parts.entryKey ? `${withConstants}|${parts.entryKey}` : withConstants;
  return parts.fragmentKey ? `${withEntry}|${parts.fragmentKey}` : withEntry;
}
function selectEntryPoint(label, entryPoints2, stage, name, where) {
  if (name === void 0)
    return entryPoints2.find((entry) => entry.stage === stage);
  if (typeof name !== "string") {
    throw entryInvalidError(label, `${stage} received ${previewConstant(name)}; expected an entry point name string.`, where);
  }
  const named = entryPoints2.find((entry) => entry.name === name);
  if (!named) {
    throw entryInvalidError(label, `"${name}" matches no entry point in the shader; available entry points: ${availableEntryPoints(entryPoints2)}.`, where);
  }
  if (named.stage !== stage) {
    throw entryInvalidError(label, `"${name}" is a @${named.stage} entry point, not @${stage}; available entry points: ${availableEntryPoints(entryPoints2)}.`, where);
  }
  return named;
}
function availableEntryPoints(entryPoints2) {
  if (!entryPoints2.length)
    return "none";
  return entryPoints2.map((entry) => `"${entry.name}" (@${entry.stage})`).join(", ");
}
function normalizeConstantsOptions(label, value, overrides, where) {
  if (value !== void 0 && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw constantsInvalidError(label, `received ${previewConstant(value)}; expected { overrideNameOrId: number | boolean }.`, where);
  }
  const byIdentifier = new Map(overrides.map((override) => [overrideIdentifierOf(override), override]));
  const constants = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!byIdentifier.has(key)) {
      throw constantsInvalidError(label, `"${key}" matches no override in the shader; available overrides: ${availableOverrides(overrides)}.`, where);
    }
    if (typeof entry === "boolean") {
      constants[key] = entry ? 1 : 0;
      continue;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw constantsInvalidError(label, `"${key}" received ${previewConstant(entry)}; use a finite number or a boolean (WebGPU converts the value to the override's WGSL type, and NaN/Infinity fail that conversion).`, where);
    }
    constants[key] = entry;
  }
  for (const override of overrides) {
    const identifier = overrideIdentifierOf(override);
    if (override.defaultValue === void 0 && !(identifier in constants)) {
      throw constantsInvalidError(label, `override '${override.name}' has no default value and must be provided; add constants: { "${identifier}": value }.`, where);
    }
  }
  if (Object.keys(constants).length === 0)
    return {};
  return { constants, constantsKey: constantsKeyFor(constants) };
}
function overrideIdentifierOf(override) {
  return override.id !== void 0 ? String(override.id) : override.name;
}
function availableOverrides(overrides) {
  if (!overrides.length)
    return "none";
  return overrides.map((override) => override.id !== void 0 ? `"${override.id}" (@id of ${override.name})` : `"${override.name}"`).join(", ");
}
function constantsKeyFor(constants) {
  return `cn~${Object.entries(constants).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${key}=${entry}`).join("~")}`;
}
function previewConstant(value) {
  if (typeof value === "string")
    return `"${value}"`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function createShaderModuleCache(device) {
  const modules = /* @__PURE__ */ new Map();
  return {
    get(source, label) {
      let module = modules.get(source);
      if (!module) {
        module = device.gpu.createShaderModule({ label, code: source });
        modules.set(source, module);
      }
      return module;
    },
    dispose() {
      modules.clear();
    }
  };
}
function createPipelineLayoutCache(device) {
  const layouts = /* @__PURE__ */ new Map();
  return {
    get(bindGroupLayouts) {
      const key = pipelineLayoutKeyOf(bindGroupLayouts);
      let layout = layouts.get(key);
      if (!layout) {
        layout = device.gpu.createPipelineLayout({ bindGroupLayouts: contiguousLayouts(bindGroupLayouts) });
        layouts.set(key, layout);
      }
      return layout;
    },
    dispose() {
      layouts.clear();
    }
  };
}
function createPipelineStore(device, opts = {}) {
  return new DevicePipelineStore(device, opts);
}
var DevicePipelineStore = class {
  device;
  #entries = /* @__PURE__ */ new Map();
  #tracked = /* @__PURE__ */ new Set();
  #errorSink;
  #unregisterSettledSource;
  #disposed = false;
  constructor(device, opts) {
    this.device = device;
    this.#errorSink = opts.errorSink ?? (() => void 0);
    this.#unregisterSettledSource = opts.registerSettledSource?.(() => [...this.#tracked]);
  }
  getReady(key) {
    return this.#entries.get(key)?.pipeline;
  }
  getSync(key, create, ctx) {
    this.#assertUsable(ctx.where);
    const existing = this.#entries.get(key);
    if (existing?.pipeline)
      return existing.pipeline;
    const entry = existing ?? {};
    if (!existing)
      this.#entries.set(key, entry);
    const pipeline = this.#createSyncPipeline(key, entry, create, ctx);
    if (!pipeline) {
      if (!entry.pending)
        this.#entries.delete(key);
      return void 0;
    }
    entry.pipeline = pipeline;
    entry.pending?.resolve(pipeline);
    entry.pending = void 0;
    return pipeline;
  }
  getAsync(key, create, ctx) {
    this.#assertUsable(ctx.where);
    const existing = this.#entries.get(key);
    if (existing?.pipeline)
      return Promise.resolve(existing.pipeline);
    if (existing?.pending)
      return existing.pending.promise;
    const entry = {};
    const pending = createDeferred();
    entry.pending = pending;
    this.#entries.set(key, entry);
    let native;
    try {
      native = create();
    } catch (cause) {
      const error = compileFailedError(ctx.where, cause, ctx.signature);
      pending.reject(error);
      this.#entries.delete(key);
      return pending.promise;
    }
    this.#track(native);
    native.then((pipeline) => {
      if (this.#entries.get(key) !== entry || entry.pipeline || entry.pending !== pending)
        return;
      entry.pipeline = pipeline;
      entry.pending = void 0;
      pending.resolve(pipeline);
    }, (cause) => {
      if (this.#entries.get(key) !== entry || entry.pipeline || entry.pending !== pending)
        return;
      entry.pending = void 0;
      this.#entries.delete(key);
      pending.reject(compileFailedError(ctx.where, cause, ctx.signature));
    });
    return pending.promise;
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#disposed = true;
    const error = compileDisposedError("gpu.dispose");
    for (const entry of this.#entries.values())
      entry.pending?.reject(error);
    this.#entries.clear();
    this.#tracked.clear();
    this.#unregisterSettledSource?.();
  }
  #createSyncPipeline(key, entry, create, ctx) {
    const gpu = this.device.gpu;
    const scoped = typeof gpu.pushErrorScope === "function" && typeof gpu.popErrorScope === "function";
    if (scoped)
      gpu.pushErrorScope("validation");
    try {
      const pipeline = create();
      if (scoped)
        this.#trackSyncErrorScope(key, entry, ctx);
      return pipeline;
    } catch (cause) {
      if (scoped)
        this.#suppressSyncErrorScopePop();
      const error = compileFailedError(ctx.where, cause, ctx.signature);
      void this.#errorSink(error);
      return void 0;
    }
  }
  #trackSyncErrorScope(key, entry, ctx) {
    const pop = this.device.gpu.popErrorScope().then((nativeError) => {
      if (!nativeError)
        return;
      const error = compileFailedError(ctx.where, nativeError, ctx.signature);
      if (this.#entries.get(key) === entry)
        this.#entries.delete(key);
      return this.#errorSink(error);
    }, (cause) => {
      const error = compileFailedError(ctx.where, cause, ctx.signature);
      if (this.#entries.get(key) === entry)
        this.#entries.delete(key);
      return this.#errorSink(error);
    });
    this.#track(pop);
  }
  #suppressSyncErrorScopePop() {
    const pop = this.device.gpu.popErrorScope?.();
    if (pop)
      void pop.catch(() => void 0);
  }
  #assertUsable(where) {
    if (!this.#disposed)
      return;
    throw compileDisposedError(where);
  }
  #track(promise) {
    this.#tracked.add(promise);
    void promise.catch(() => void 0).then(() => this.#tracked.delete(promise), () => this.#tracked.delete(promise));
  }
};
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => void 0);
  return { promise, resolve, reject };
}
function idFor(ids, value, next) {
  let id = ids.get(value);
  if (!id) {
    id = next();
    ids.set(value, id);
  }
  return id;
}
function vertexLayoutHash(layouts) {
  return JSON.stringify(layouts.map((layout) => ({
    arrayStride: layout.arrayStride,
    stepMode: layout.stepMode ?? "vertex",
    attributes: [...layout.attributes].map((attribute) => ({
      shaderLocation: attribute.shaderLocation,
      offset: attribute.offset,
      format: attribute.format
    }))
  })));
}
function pipelineLayoutKeyOf(layouts) {
  return JSON.stringify([...layouts.entries()].map(([group, layout]) => ({ group, entries: layoutEntries(layout) })));
}
function contiguousLayouts(bindGroupLayouts) {
  const maxGroup = Math.max(-1, ...bindGroupLayouts.keys());
  const layouts = [];
  for (let i = 0; i <= maxGroup; i++)
    layouts.push(requiredLayout(bindGroupLayouts, i));
  return layouts;
}
function requiredLayout(bindGroupLayouts, group) {
  const layout = bindGroupLayouts.get(group);
  if (!layout)
    throw pipelineLayoutGapError(group);
  return layout;
}
function layoutEntries(layout) {
  return (bindGroupLayoutMetadata(layout)?.entries ?? []).map((entry) => ({
    binding: entry.binding,
    visibility: entry.visibility,
    buffer: entry.buffer ? { ...entry.buffer } : void 0,
    sampler: entry.sampler ? { ...entry.sampler } : void 0,
    texture: entry.texture ? { ...entry.texture } : void 0,
    storageTexture: entry.storageTexture ? { ...entry.storageTexture } : void 0,
    externalTexture: entry.externalTexture ? { ...entry.externalTexture } : void 0
  }));
}

// node_modules/vgpu/dist/frame-state.js
var frameStateToken = serviceToken("frame-state");
function frameState(kernel) {
  return kernel.service(frameStateToken, createFrameState);
}
function createFrameState() {
  const hooks = /* @__PURE__ */ new Set();
  let lastTimeMs = nowMs();
  let ticking = false;
  let manualPending = false;
  const state = {
    time: 0,
    deltaTime: 0,
    frameCount: 0,
    advanceBy(dtSeconds) {
      state.deltaTime = dtSeconds;
      state.time += dtSeconds;
      manualPending = true;
    },
    tick() {
      if (ticking)
        throw frameReentrantError();
      ticking = true;
      try {
        const next = nowMs();
        if (manualPending) {
          manualPending = false;
        } else {
          state.deltaTime = Math.max(0, (next - lastTimeMs) / 1e3);
          state.time += state.deltaTime;
        }
        lastTimeMs = next;
        state.frameCount += 1;
        for (const hook of [...hooks])
          hook();
      } finally {
        ticking = false;
      }
    },
    onAdvance(hook) {
      hooks.add(hook);
      return () => {
        hooks.delete(hook);
      };
    }
  };
  return state;
}
function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

// node_modules/vgpu/dist/surface.js
function surface(gpu, canvas, opts = {}) {
  const kernel = liveKernel(gpu, "surface");
  const open = openSurfaces(kernel);
  const existing = open.get(canvas);
  if (existing && !existing.disposed)
    throw surfaceDuplicateError(existing.label);
  const created = new CanvasSurface(kernel.device, canvas, opts, (disposed) => {
    if (open.get(disposed.canvas) === disposed)
      open.delete(disposed.canvas);
    releaseAutoResize();
    releaseOwnership();
  });
  const releaseAutoResize = frameState(kernel).onAdvance(() => created.applyAutoResize());
  const releaseOwnership = kernel.own("resource", () => created.dispose());
  open.set(canvas, created);
  return created;
}
var openSurfacesToken = serviceToken("surfaces");
function openSurfaces(kernel) {
  return kernel.service(openSurfacesToken, () => /* @__PURE__ */ new Map());
}
var resizeCallbackDepth = 0;
var frameDepth = 0;
function isSurfaceResizeCallbackActive() {
  return resizeCallbackDepth > 0;
}
function isFrameActive() {
  return frameDepth > 0;
}
function enterFrame() {
  frameDepth += 1;
}
function leaveFrame() {
  frameDepth -= 1;
}
function isSurface(target2) {
  return target2 instanceof CanvasSurface;
}
var CanvasSurface = class {
  device;
  canvas;
  options;
  unregister;
  resourceIdentity = createResourceIdentity("render-target");
  label;
  context;
  autoResize;
  layoutBacked;
  format;
  #destroySignal = new DestroySignal();
  #callbacks = /* @__PURE__ */ new Set();
  #texturesRecreatedCallbacks = /* @__PURE__ */ new Set();
  #currentDpr;
  #clearColor;
  #isDisposed = false;
  #notifying = false;
  constructor(device, canvas, options, unregister) {
    this.device = device;
    this.canvas = canvas;
    this.options = options;
    this.unregister = unregister;
    this.label = options.label;
    this.#clearColor = options.clearColor === void 0 ? BUILT_IN_CLEAR_COLOR : validateClearColor(options.clearColor, "surface.clearColor");
    const context = canvas.getContext("webgpu");
    if (!context)
      throw surfaceContextError();
    this.context = context;
    this.layoutBacked = isLayoutBacked(canvas);
    if (options.autoResize === true && !this.layoutBacked)
      throw surfaceAutoResizeUnsupportedError();
    this.autoResize = options.autoResize ?? (options.size ? false : this.layoutBacked);
    this.#currentDpr = effectiveDpr(options.dpr);
    this.format = options.format ?? preferredCanvasFormat();
    const initialSize = initialCanvasSize(canvas, options, this.layoutBacked, this.#currentDpr);
    if (options.size || this.layoutBacked)
      setCanvasSize(canvas, initialSize);
    context.configure({
      device: device.gpu,
      format: this.format,
      alphaMode: options.alphaMode ?? "premultiplied",
      colorSpace: options.colorSpace ?? "srgb",
      usage: canvasTextureUsage()
    });
  }
  get gpu() {
    return this.context;
  }
  get size() {
    this.#assertLive();
    return canvasSize(this.canvas);
  }
  get texelSize() {
    const size = this.size;
    return [1 / size[0], 1 / size[1]];
  }
  get color() {
    this.#assertLive();
    return new Texture(this.device, this.context.getCurrentTexture(), {
      kind: "2d",
      size: this.size,
      format: this.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      label: this.options.label ? `${this.options.label}.color` : "surface.color"
    }, "external");
  }
  get colors() {
    return [this.color];
  }
  get depth() {
    this.#assertLive();
    return void 0;
  }
  get sampleCount() {
    this.#assertLive();
    return 1;
  }
  get dpr() {
    return this.#currentDpr;
  }
  /** Default clear color of this surface; passes that clear without naming a color use it. */
  get clearColor() {
    return copyClearColor(this.#clearColor);
  }
  set clearColor(value) {
    this.#clearColor = validateClearColor(value, "surface.clearColor");
  }
  get disposed() {
    return this.#isDisposed;
  }
  resize(size) {
    this.#assertLive();
    if (this.#notifying)
      throw surfaceResizeReentrantError(this.options.label);
    this.#applyResize(sanitizeSize(size), this.#currentDpr, true);
  }
  applyAutoResize() {
    if (this.#isDisposed || !this.autoResize || !this.layoutBacked)
      return;
    const nextDpr = effectiveDpr(this.options.dpr);
    const nextSize = layoutCanvasSize(this.canvas, nextDpr);
    this.#applyResize(nextSize, nextDpr, true);
  }
  onResize(cb) {
    this.#assertLive();
    this.#callbacks.add(cb);
    this.#notifying = true;
    resizeCallbackDepth += 1;
    try {
      cb(this.#event());
    } finally {
      resizeCallbackDepth -= 1;
      this.#notifying = false;
    }
    return () => {
      this.#callbacks.delete(cb);
    };
  }
  onDestroy(cb) {
    this.#assertLive();
    return this.#destroySignal.onDestroy(this, cb);
  }
  onTexturesRecreated(cb) {
    this.#assertLive();
    this.#texturesRecreatedCallbacks.add(cb);
    return () => {
      this.#texturesRecreatedCallbacks.delete(cb);
    };
  }
  renderPassDescriptor(opts = {}) {
    const { clear = [0, 0, 0, 1], preserve } = opts;
    this.#assertLive();
    const attachment = { view: this.context.getCurrentTexture().createView(), loadOp: preserve ? "load" : "clear", storeOp: "store" };
    if (!preserve)
      attachment.clearValue = colorValue(clear);
    return { colorAttachments: [attachment] };
  }
  dispose() {
    if (this.#isDisposed)
      return;
    this.#isDisposed = true;
    try {
      this.context.unconfigure?.();
    } catch {
    }
    this.unregister(this);
    this.#callbacks.clear();
    this.#texturesRecreatedCallbacks.clear();
    this.#destroySignal.emit(this);
  }
  #applyResize(size, dpr, notify) {
    const changed = !sameSize(canvasSize(this.canvas), size);
    this.#currentDpr = dpr;
    if (!changed)
      return;
    setCanvasSize(this.canvas, size);
    this.#emitTexturesRecreated();
    if (notify)
      this.#notify();
  }
  #emitTexturesRecreated() {
    for (const cb of [...this.#texturesRecreatedCallbacks])
      cb();
  }
  #notify() {
    this.#notifying = true;
    resizeCallbackDepth += 1;
    try {
      const event = this.#event();
      for (const cb of [...this.#callbacks])
        cb(event);
    } finally {
      resizeCallbackDepth -= 1;
      this.#notifying = false;
    }
  }
  #event() {
    const size = canvasSize(this.canvas);
    return { width: size[0], height: size[1], dpr: this.#currentDpr, surface: this };
  }
  #assertLive() {
    if (this.#isDisposed)
      throw surfaceDisposedError(this.options.label);
  }
};
function isLayoutBacked(canvas) {
  return typeof canvas.clientWidth === "number";
}
function initialCanvasSize(canvas, options, layoutBacked, dpr) {
  if (options.size)
    return sanitizeSize(options.size);
  if (layoutBacked)
    return layoutCanvasSize(canvas, dpr);
  return sanitizeSize(canvasSize(canvas));
}
function layoutCanvasSize(canvasLike, dpr) {
  const canvas = canvasLike;
  return sanitizeSize([Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr)]);
}
function canvasSize(canvasLike) {
  const canvas = canvasLike;
  return [canvas.width, canvas.height];
}
function setCanvasSize(canvasLike, size) {
  const canvas = canvasLike;
  canvas.width = size[0];
  canvas.height = size[1];
}
function sanitizeSize(size) {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
function effectiveDpr(dpr) {
  const raw = globalThis.devicePixelRatio ?? 1;
  if (Array.isArray(dpr))
    return Math.min(dpr[1], Math.max(dpr[0], raw));
  if (typeof dpr === "number")
    return dpr;
  return raw;
}
function preferredCanvasFormat() {
  return globalThis.navigator?.gpu?.getPreferredCanvasFormat?.() ?? "bgra8unorm";
}
function canvasTextureUsage() {
  const usage = globalThis.GPUTextureUsage;
  return usage ? usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING | usage.COPY_SRC : void 0;
}

// node_modules/vgpu/dist/indirect.js
var INDIRECT_METHODS = {
  drawIndirect: { bytes: 16, args: "4 u32 values: vertexCount, instanceCount, firstVertex, firstInstance" },
  drawIndexedIndirect: { bytes: 20, args: "5 32-bit values: indexCount, instanceCount, firstIndex, baseVertex (signed), firstInstance" },
  dispatchWorkgroupsIndirect: { bytes: 12, args: "3 u32 values: workgroupCountX, workgroupCountY, workgroupCountZ" }
};
function resolveIndirect(label, where, value, method) {
  const wrapped = typeof value === "object" && value !== null ? value.buffer : void 0;
  const storage = isStorageBufferFacade(value) ? value : isStorageBufferFacade(wrapped) ? wrapped : void 0;
  if (!storage)
    throw indirectInvalidError(label, `received ${previewIndirect(value)}; expected a StorageBuffer or { buffer, offset? }.`, where);
  const offset = storage === value ? 0 : value.offset ?? 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    throw indirectInvalidError(label, `offset must be an integer >= 0; received ${previewIndirect(offset)}.`, where);
  if (offset % 4 !== 0)
    throw indirectInvalidError(label, `offset must be a multiple of 4 (WebGPU requires "indirectOffset is a multiple of 4"); received ${offset}.`, where);
  if (!storage.buffer.options.usage.includes("indirect")) {
    throw indirectInvalidError(label, `the buffer lacks the "indirect" usage (WebGPU requires "indirectBuffer.usage contains INDIRECT"); create it with storage(gpu, ${storage.size}, { indirect: true }).`, where);
  }
  const { bytes, args } = INDIRECT_METHODS[method];
  if (offset + bytes > storage.size) {
    throw indirectInvalidError(label, `${method} reads ${bytes} bytes (${args}) at offset ${offset}, but offset + ${bytes} = ${offset + bytes} exceeds the buffer size ${storage.size}.`, where);
  }
  return { buffer: storage.gpu, offset };
}
function isStorageBufferFacade(value) {
  return typeof value === "object" && value !== null && "gpu" in value && "size" in value && value.buffer instanceof Buffer;
}
function previewIndirect(value) {
  if (typeof value === "string")
    return `"${value}"`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// node_modules/vgpu/dist/frame-protocols.js
var FRAME_DRAWABLE = /* @__PURE__ */ Symbol("vgpu.frame.drawable");
function frameDrawableOf(value) {
  return value?.[FRAME_DRAWABLE];
}
var FRAME_BUNDLE = /* @__PURE__ */ Symbol("vgpu.frame.bundle");
function frameBundleOf(value) {
  return value?.[FRAME_BUNDLE];
}
var FRAME_PASS_ATTACHMENT = /* @__PURE__ */ Symbol("vgpu.frame.passAttachment");
function framePassAttachmentOf(value) {
  const attach = value?.[FRAME_PASS_ATTACHMENT];
  return typeof attach === "function" ? value : void 0;
}

// node_modules/vgpu/dist/sampler.js
function sampler(gpu, desc) {
  return renderService(liveKernel(gpu, "sampler")).sampler(desc);
}
var nextSamplerId = 1;
function createSamplerCache(device) {
  const byKey = /* @__PURE__ */ new Map();
  const ids = /* @__PURE__ */ new WeakMap();
  return {
    sampler(desc = {}) {
      const key = stableKey(desc);
      let sampler2 = byKey.get(key);
      if (!sampler2) {
        sampler2 = device.gpu.createSampler(desc);
        byKey.set(key, sampler2);
        ids.set(sampler2, { kind: "sampler", id: nextSamplerId++ });
      }
      return sampler2;
    },
    identity(sampler2) {
      let id = ids.get(sampler2);
      if (!id) {
        id = { kind: "sampler", id: nextSamplerId++ };
        ids.set(sampler2, id);
      }
      return id;
    }
  };
}
function stableKey(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableKey).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`).join(",")}}`;
}

// node_modules/vgpu/dist/render-service.js
var renderServiceToken = serviceToken("render-service");
function renderService(kernel) {
  return kernel.service(renderServiceToken, createRenderService);
}
function createRenderService(kernel) {
  const device = kernel.device;
  const binds = createBindGroupCache();
  const pipelines = createPipelineStore(device, {
    errorSink: (error) => kernel.reportError(error),
    registerSettledSource: (source) => kernel.registerSettledSource(source)
  });
  const shaderModules = createShaderModuleCache(device);
  const pipelineLayouts = createPipelineLayoutCache(device);
  const samplers = createSamplerCache(device);
  kernel.own("service", () => {
    pipelines.dispose();
    shaderModules.dispose();
    pipelineLayouts.dispose();
    binds.dispose();
  });
  return { binds, pipelines, shaderModules, pipelineLayouts, sampler: (desc) => samplers.sampler(desc) };
}

// node_modules/vgpu/dist/shader-source.js
function toWgsl(input) {
  if (typeof input === "string")
    return input;
  if (!isObject(input))
    throw malformedShaderSourceError(input);
  if (!("version" in input))
    throw malformedShaderSourceError(input);
  const version = input.version;
  if (version !== 1)
    throw malformedShaderSourceError(input);
  const wgsl = input.wgsl;
  if (typeof wgsl !== "string")
    throw malformedShaderSourceError(input);
  return wgsl;
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}

// node_modules/vgpu/dist/draw.js
function draw(gpu, opts) {
  const kernel = liveKernel(gpu, "draw");
  const render = renderService(kernel);
  const shader = toWgsl(opts.shader);
  return new InternalDraw(kernel.device, shader, { ...opts, shader }, render.binds, void 0, render.pipelines, render.shaderModules, render.pipelineLayouts, (error) => kernel.reportError(error), (promise) => {
    void kernel.trackDelivery(promise);
  });
}
var nextDrawId = 1;
var drawStates = /* @__PURE__ */ new WeakMap();
var InternalDraw = class {
  source;
  label;
  #dynamicBindGroupLayouts = /* @__PURE__ */ new Map();
  constructor(device, source, opts, cache2 = createBindGroupCache(), defaultTarget, pipelineStore = createPipelineStore(device), shaderModules = createShaderModuleCache(device), pipelineLayouts = createPipelineLayoutCache(device), errorSink, trackSettled) {
    this.source = source;
    assertDeviceUsable(device, "Draw.constructor");
    this.label = opts.label ?? "draw";
    const id = nextDrawId++;
    const reflection = reflectSource(source, `${this.label}.wgsl`);
    const entryNames = normalizeEntryOptions(this.label, opts.entry);
    const vertexEntry = selectEntryPoint(this.label, reflection.entryPoints, "vertex", entryNames.vertex, "draw");
    const fragmentEntry = selectEntryPoint(this.label, reflection.entryPoints, "fragment", entryNames.fragment, "draw");
    const entryKey = entryKeyFor(reflection, vertexEntry, fragmentEntry);
    const selectedEntries = [vertexEntry, fragmentEntry].filter((entry) => !!entry);
    const visibility = visibilityForEntries(reflection.bindings, selectedEntries);
    validateStorageStageLimits(device, this.label, reflection.bindings, selectedEntries, visibility);
    const geometry2 = opts.geometry;
    const inputs = vertexEntry ? entryMetadata(vertexEntry, "inputs", this.label) : [];
    const vertexBufferLayouts = geometry2 && geometryLayoutResolver in geometry2 ? geometry2[geometryLayoutResolver](inputs, `${this.label}.geometry`) : geometry2?.vertexBufferLayouts;
    const bindGroupLayouts = new Map(bindGroupLayoutsForReflection(device, this.label, reflection, visibility));
    const pipelineLayout = pipelineLayouts.get(bindGroupLayouts);
    const shaderModule = shaderModules.get(source, `${this.label}.shader`);
    const recordedIn = createBundleRegistry();
    const fragmentState = normalizeFragmentState(this.label, opts);
    const blendConstantOptions = normalizeBlendConstantOptions(this.label, opts, fragmentState);
    const primitiveOptions = normalizePrimitiveOptions(device, this.label, opts);
    const depthOptions = normalizeDepthOptions(device, this.label, opts);
    const stencilOptions = normalizeStencilOptions(this.label, opts);
    const multisampleOptions = normalizeMultisampleOptions(this.label, opts);
    const constantsOptions = normalizeConstantsOptions(this.label, opts.constants, reflection.overrides, "draw");
    const setCore = createSetCore({
      device,
      label: this.label,
      drawId: id,
      reflection,
      bindGroupLayouts,
      cache: cache2,
      onIdentityChange: (change) => recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change })
    });
    drawStates.set(this, { id, device, opts, vertexBufferLayouts, cache: cache2, defaultTarget, reflection, visibility, vertexEntry: vertexEntry?.name ?? "vs_main", fragmentEntry: fragmentEntry?.name ?? "fs_main", entryKey, setCore, bindGroupLayouts, pipelineLayout, shaderModule, pipelineStore, pipelineLayouts, errorSink, trackSettled, resolvedPipelineKeys: /* @__PURE__ */ new Set(), recordedIn, ...fragmentState, ...blendConstantOptions, ...primitiveOptions, ...depthOptions, ...stencilOptions, ...multisampleOptions, ...constantsOptions });
    if (opts.set)
      this.set(opts.set);
    for (const target2 of opts.targets ?? [])
      this.compileSync(target2);
  }
  get gpu() {
    const state = drawState(this);
    for (const key of state.resolvedPipelineKeys) {
      const pipeline = state.pipelineStore.getReady(key);
      if (pipeline)
        return pipeline;
    }
    return void 0;
  }
  get targets() {
    return drawState(this).opts.targets;
  }
  /**
   * Frame drawable protocol: a `Frame` encodes through this instead of importing draw.ts, so a
   * program that never draws never pulls this module. The instance is its own protocol object —
   * `encode`, `label` and the depth/stencil metadata below are exactly what a pass needs.
   */
  get [FRAME_DRAWABLE]() {
    return this;
  }
  /** @internal Frame drawable protocol; see {@link drawWritesDepth}. */
  writesDepth() {
    return drawWritesDepth(this);
  }
  /** @internal Frame drawable protocol; see {@link drawStencilWritingOps}. */
  stencilWritingOps() {
    return drawStencilWritingOps(this);
  }
  set(values) {
    const state = drawState(this);
    assertDeviceUsable(state.device, `${this.label}.set`);
    for (const change of state.setCore.set(values))
      state.recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change });
    return this;
  }
  group(n, bindGroup) {
    const state = drawState(this);
    assertDeviceUsable(state.device, `${this.label}.group`);
    const expectedLayout = this.#dynamicBindGroupLayouts.get(n) ?? this.layout(n);
    const previousIdentity = state.setCore.claimGroup(n, bindGroup, expectedLayout);
    state.recordedIn.markStale({ kind: "group-claim", drawLabel: this.label, group: n, previousIdentity, newIdentity: `claimed-group:${n}` });
    return this;
  }
  layout(n, opts = {}) {
    assertDeviceUsable(drawState(this).device, `${this.label}.layout`);
    if (!opts.dynamicOffsets)
      return drawState(this).setCore.layout(n);
    return this.#dynamicLayout(n);
  }
  #dynamicLayout(group) {
    const state = drawState(this);
    state.setCore.layout(group);
    const existing = this.#dynamicBindGroupLayouts.get(group);
    if (existing)
      return existing;
    const entries = dynamicEntries(this, group);
    const layout = cachedBindGroupLayout(state.device, `${this.label}.group${group}.dynamic.bgl`, entries);
    this.#dynamicBindGroupLayouts.set(group, layout);
    state.bindGroupLayouts.set(group, layout);
    state.pipelineLayout = state.pipelineLayouts.get(state.bindGroupLayouts);
    return layout;
  }
  /**
   * Encodes and submits this draw as a one-shot render pass.
   *
   * Raw claimed-bind-group validation failures are delivered asynchronously via
   * `gpu.onError` as `VGPU-R4-GROUP-VALIDATION`.
   */
  draw(arg = {}) {
    assertDeviceUsable(drawState(this).device, `${this.label}.draw`);
    const opts = isTarget(arg) ? { target: arg } : arg;
    const state = drawState(this);
    const target2 = opts.target ?? state.defaultTarget;
    if (!target2)
      throw targetRequiredError(`${this.label}.draw`);
    assertSurfaceTargetInFrame(target2, `${this.label}.draw`);
    const encoder = state.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass(target2.renderPassDescriptor());
    const validations = [];
    try {
      this.encode(pass, target2, opts, (result) => validations.push(result));
    } catch (error) {
      discardClaimedGroupValidationResults(validations);
      discardClaimedGroupValidationScopes(state.device);
      try {
        pass.end();
      } catch {
      }
      throw error;
    }
    endRenderPassWithClaimValidation(state.device, pass, validations, validations[0]?.context);
    let commandBuffer;
    const finishContext = validations[0]?.context;
    if (finishContext)
      pushClaimedGroupValidationScope(state.device, finishContext);
    try {
      commandBuffer = encoder.finish();
    } catch (error) {
      const result = finishContext ? popLastClaimedGroupValidationScope(state.device) : void 0;
      discardClaimedGroupValidationResults(validations);
      if (result)
        discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? finishContext;
      if (context) {
        void reportDrawValidationError(state, context.label, context.group, error);
        return;
      }
      throw error;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(state.device);
      if (result)
        validations[0] = validations[0] ? preferClaimedGroupValidationResult(result, validations[0]) : result;
    }
    const submitContext = validations[0]?.context;
    if (submitContext)
      pushClaimedGroupValidationScope(state.device, submitContext);
    try {
      state.device.gpu.queue.submit([commandBuffer]);
    } catch (error) {
      const result = submitContext ? popLastClaimedGroupValidationScope(state.device) : void 0;
      discardClaimedGroupValidationResults(validations);
      if (result)
        discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (context) {
        void reportDrawValidationError(state, context.label, context.group, error);
        return;
      }
      throw error;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(state.device);
      if (result)
        validations[0] = validations[0] ? preferClaimedGroupValidationResult(result, validations[0]) : result;
    }
    if (validations.length) {
      const done = claimedGroupValidationDone(state.device, validations, { errorSink: state.errorSink });
      state.trackSettled?.(done);
    }
  }
  encode(pass, target2, opts = {}, claimValidation) {
    assertDeviceUsable(drawState(this).device, `${this.label}.encode`);
    drawState(this).setCore.assertUsable();
    const pipeline = this.pipelineFor(target2, true);
    if (!pipeline)
      return;
    pass.setPipeline(pipeline);
    const state = drawState(this);
    if (state.blendConstant)
      pass.setBlendConstant(state.blendConstant);
    if (state.stencilRef !== void 0)
      pass.setStencilReference(state.stencilRef);
    for (const binding of state.setCore.bindGroups())
      this.#setBindGroup(pass, binding, opts, claimValidation);
    this.#encodeGeometry(pass, opts);
  }
  #setBindGroup(pass, binding, opts, claimValidation) {
    const offsets = offsetsForGroup(opts.offsets, binding.group, binding.offsets);
    if (!binding.claimValidation || !claimValidation) {
      pass.setBindGroup(binding.group, binding.bindGroup, offsets);
      return;
    }
    pushClaimedGroupValidationScope(drawState(this).device, binding.claimValidation);
    try {
      pass.setBindGroup(binding.group, binding.bindGroup, offsets);
    } catch (error) {
      discardLastClaimedGroupValidationScope(drawState(this).device);
      throw claimedGroupNativeValidationError(binding.claimValidation.label, binding.claimValidation.group, error);
    }
    const result = popLastClaimedGroupValidationScope(drawState(this).device);
    if (result)
      claimValidation(result);
  }
  compile(target2) {
    assertDeviceUsable(drawState(this).device, `${this.label}.compile`);
    const { key, signature, signatureKey } = this.#compileKey(target2, `${this.label}.compile`);
    const promise = drawState(this).pipelineStore.getAsync(key, () => this.#createPipelineAsync(signature), { where: `${this.label}.compile`, signature: signatureKey });
    return promise.then(() => {
      assertDeviceUsable(drawState(this).device, `${this.label}.compile`);
      drawState(this).resolvedPipelineKeys.add(key);
      return this;
    });
  }
  compileSync(target2) {
    assertDeviceUsable(drawState(this).device, `${this.label}.compileSync`);
    const { key, signature, signatureKey } = this.#compileKey(target2, `${this.label}.compileSync`);
    const pipeline = drawState(this).pipelineStore.getSync(key, () => this.#createPipeline(signature), { where: `${this.label}.compileSync`, signature: signatureKey });
    if (pipeline)
      drawState(this).resolvedPipelineKeys.add(key);
    return this;
  }
  pipelineFor(target2, allowSurface = false) {
    assertDeviceUsable(drawState(this).device, `${this.label}.pipelineFor`);
    const { key, signature, signatureKey } = this.#compileKey(target2, `${this.label}.pipelineFor`, allowSurface);
    const pipeline = drawState(this).pipelineStore.getSync(key, () => this.#createPipeline(signature), { where: `${this.label}.pipelineFor`, signature: signatureKey });
    if (pipeline)
      drawState(this).resolvedPipelineKeys.add(key);
    return pipeline;
  }
  pipelineForAsync(target2) {
    assertDeviceUsable(drawState(this).device, `${this.label}.pipelineForAsync`);
    const { key, signature, signatureKey } = this.#compileKey(target2, `${this.label}.pipelineForAsync`);
    const promise = drawState(this).pipelineStore.getAsync(key, () => this.#createPipelineAsync(signature), { where: `${this.label}.pipelineForAsync`, signature: signatureKey });
    return promise.then((pipeline) => {
      assertDeviceUsable(drawState(this).device, `${this.label}.pipelineForAsync`);
      drawState(this).resolvedPipelineKeys.add(key);
      return pipeline;
    });
  }
  #compileKey(target2, where, allowSurface = false) {
    const signature = this.#signatureForKeyTarget(target2, where, allowSurface);
    const signatureKey = signatureKeyOf(signature);
    return { signature, signatureKey, key: this.#pipelineKey(signature) };
  }
  #signatureForKeyTarget(target2, where, allowSurface = false) {
    const state = drawState(this);
    const resolvedTarget = target2 ?? state.defaultTarget;
    if (!resolvedTarget)
      throw targetRequiredError(where);
    if (!allowSurface)
      assertSurfaceTargetInFrame(resolvedTarget, where);
    const signature = normalizeSignature(resolvedTarget);
    validateTargetSignature(signature, where);
    if (state.colorStates && state.colorStates.length !== signature.colors.length) {
      throw colorsInvalidError(this.label, `expected one entry per color attachment; colors has ${state.colorStates.length}, but the target signature has ${signature.colors.length}.`, where);
    }
    if (state.multisampleState?.alphaToCoverageEnabled && (signature.sampleCount ?? 1) <= 1) {
      throw multisampleInvalidError(this.label, `alphaToCoverage requires a multisampled target, but the target signature has sampleCount ${signature.sampleCount ?? 1}; create the target with msaa: true.`, where);
    }
    if ((state.stencilState || state.stencilRef !== void 0) && !hasStencilAspect(signature.depth)) {
      throw stencilInvalidError(this.label, `stencil requires a depth format with a stencil aspect, but the target signature has ${signature.depth ? `"${signature.depth}"` : "no depth"}; create the target with depth: "depth24plus-stencil8".`, where);
    }
    return signature;
  }
  #pipelineKey(signature) {
    const state = drawState(this);
    const geometry2 = state.opts.geometry;
    return pipelineKeyOf({ module: state.shaderModule, pipelineLayout: state.pipelineLayout, vertexBufferLayouts: state.vertexBufferLayouts, signature, fragmentKey: state.fragmentKey, topology: geometry2?.topology, stripIndexFormat: stripIndexFormatFor(geometry2), cullMode: state.cullMode, frontFace: state.frontFace, unclippedDepth: state.unclippedDepth, depthKey: state.depthKey, stencilKey: state.stencilKey, multisampleKey: state.multisampleKey, constantsKey: state.constantsKey, entryKey: state.entryKey });
  }
  #encodeGeometry(pass, callOpts = {}) {
    const geometry2 = drawState(this).opts.geometry;
    if (geometry2?.vertexBuffers)
      geometry2.vertexBuffers.forEach((buffer, index) => pass.setVertexBuffer(index, buffer));
    if (callOpts.indirect !== void 0)
      return this.#encodeIndirect(pass, geometry2, callOpts);
    const counts = resolveDrawCounts(this.label, geometry2, drawState(this).opts, callOpts);
    if (!geometry2?.indexBuffer)
      return pass.draw(counts.vertexCount, counts.instanceCount, counts.firstVertex, counts.firstInstance);
    pass.setIndexBuffer(geometry2.indexBuffer, geometry2.indexFormat ?? "uint32");
    pass.drawIndexed(counts.indexCount, counts.instanceCount, counts.firstIndex, counts.baseVertex, counts.firstInstance);
  }
  /**
   * The GPU reads the draw arguments from the buffer, so per-call counts alongside indirect are dead options and throw.
   * A non-zero firstInstance in the buffered arguments cannot be validated on the CPU; per WebGPU, it "must be 0,
   * unless the 'indirect-first-instance' feature is enabled", otherwise the indirect call "will be treated as a no-op".
   */
  #encodeIndirect(pass, geometry2, callOpts) {
    const where = `${this.label}.draw`;
    const conflict = INDIRECT_CONFLICT_FIELDS.find((field) => callOpts[field] !== void 0);
    if (conflict !== void 0)
      throw indirectInvalidError(this.label, `indirect cannot be combined with ${conflict} in the same call; the GPU reads the draw arguments from the buffer, so the CPU-side value would be ignored.`, where);
    const indexed = !!geometry2?.indexBuffer;
    const { buffer, offset } = resolveIndirect(this.label, where, callOpts.indirect, indexed ? "drawIndexedIndirect" : "drawIndirect");
    if (!indexed)
      return pass.drawIndirect(buffer, offset);
    pass.setIndexBuffer(geometry2.indexBuffer, geometry2.indexFormat ?? "uint32");
    pass.drawIndexedIndirect(buffer, offset);
  }
  #createPipeline(signature) {
    const state = drawState(this);
    return state.device.gpu.createRenderPipeline({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: state.vertexEntry, buffers: [...state.vertexBufferLayouts ?? []], ...state.constants ? { constants: state.constants } : {} },
      fragment: { module: state.shaderModule, entryPoint: state.fragmentEntry, targets: fragmentTargets(signature, state), ...state.constants ? { constants: state.constants } : {} },
      primitive: primitiveState(state.opts.geometry, state.cullMode, state.frontFace, state.unclippedDepth),
      depthStencil: depthStencilState(signature, state),
      multisample: multisampleStateFor(signature, state)
    });
  }
  #createPipelineAsync(signature) {
    const state = drawState(this);
    return state.device.gpu.createRenderPipelineAsync({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: state.vertexEntry, buffers: [...state.vertexBufferLayouts ?? []], ...state.constants ? { constants: state.constants } : {} },
      fragment: { module: state.shaderModule, entryPoint: state.fragmentEntry, targets: fragmentTargets(signature, state), ...state.constants ? { constants: state.constants } : {} },
      primitive: primitiveState(state.opts.geometry, state.cullMode, state.frontFace, state.unclippedDepth),
      depthStencil: depthStencilState(signature, state),
      multisample: multisampleStateFor(signature, state)
    });
  }
};
function validateStorageStageLimits(device, label, bindings, entries, visibility) {
  const limits = device.limits;
  for (const [stage, flag, limitName] of [["vertex", 1, "maxStorageBuffersInVertexStage"], ["fragment", 2, "maxStorageBuffersInFragmentStage"]]) {
    const entry = entries.find((item) => item.stage === stage);
    if (!entry)
      continue;
    const used = bindings.filter((binding) => binding.bindingLayout?.kind === "buffer" && binding.bindingLayout.buffer.type !== "uniform" && visibility(binding) & flag);
    const limit = limits[limitName] ?? limits.maxStorageBuffersPerShaderStage;
    if (limit !== void 0 && used.length > limit)
      throw storageStageLimitError(label, stage, entry.name, used.length, limit, used);
  }
}
var INDIRECT_CONFLICT_FIELDS = ["vertices", "indices", "instances", "firstVertex", "firstIndex", "baseVertex", "firstInstance"];
function fragmentTargets(signature, state) {
  return signature.colors.map((format, index) => {
    const overrides = state.colorStates?.[index];
    const blendState2 = overrides?.blendState ?? state.blendState;
    const writeMask = overrides?.writeMask ?? state.writeMask;
    const target2 = { format };
    if (blendState2)
      target2.blend = blendState2;
    if (writeMask !== void 0)
      target2.writeMask = writeMask;
    return target2;
  });
}
function resolveDrawCounts(label, geometry2, drawOpts, callOpts) {
  validateOptionalDrawCount(label, "DrawOptions.instances", drawOpts.instances);
  validateOptionalDrawCount(label, "DrawOptions.vertices", drawOpts.vertices);
  validateOptionalDrawCount(label, "DrawOptions.firstInstance", drawOpts.firstInstance);
  validateOptionalDrawCount(label, "DrawCallOptions.instances", callOpts.instances);
  validateOptionalGeometryRange(label, "DrawCallOptions.vertices", callOpts.vertices);
  validateOptionalGeometryRange(label, "DrawCallOptions.indices", callOpts.indices);
  validateOptionalGeometryRange(label, "DrawCallOptions.firstVertex", callOpts.firstVertex);
  validateOptionalGeometryRange(label, "DrawCallOptions.firstIndex", callOpts.firstIndex);
  validateOptionalGeometryRange(label, "DrawCallOptions.baseVertex", callOpts.baseVertex);
  validateOptionalDrawCount(label, "DrawCallOptions.firstInstance", callOpts.firstInstance);
  validateOptionalDrawCount(label, "GeometryLike.vertexCount", geometry2?.vertexCount);
  validateOptionalDrawCount(label, "GeometryLike.indexCount", geometry2?.indexCount);
  validateOptionalDrawCount(label, "GeometryLike.instanceCount", geometry2?.instanceCount);
  validateOptionalGeometryRange(label, "GeometryLike.firstVertex", geometry2?.firstVertex);
  validateOptionalGeometryRange(label, "GeometryLike.firstIndex", geometry2?.firstIndex);
  validateOptionalGeometryRange(label, "GeometryLike.baseVertex", geometry2?.baseVertex);
  const indexed = !!geometry2?.indexBuffer;
  const sliceParent = geometry2?.geometry;
  const parent = sliceParent ?? (geometry2 && geometryLayoutResolver in geometry2 ? geometry2 : void 0);
  const firstVertex = callOpts.firstVertex ?? geometry2?.firstVertex ?? 0;
  const vertexCount = callOpts.vertices ?? geometry2?.vertexCount ?? drawOpts.vertices ?? 3;
  const firstIndex = callOpts.firstIndex ?? geometry2?.firstIndex ?? 0;
  const indexCount = callOpts.indices ?? geometry2?.indexCount ?? 0;
  const baseVertex = callOpts.baseVertex ?? geometry2?.baseVertex ?? 0;
  if (indexed)
    validateDrawInterval(label, "index", firstIndex, indexCount, parent?.indexCount);
  else if (callOpts.indices !== void 0 || callOpts.firstIndex !== void 0 || callOpts.baseVertex !== void 0)
    throw meshRangeInvalidError(`${label}.draw`, "Index range needs an indexed geometry.");
  if (!indexed)
    validateDrawInterval(label, "vertex", firstVertex, vertexCount, parent?.vertexCount);
  return {
    instanceCount: callOpts.instances ?? drawOpts.instances ?? geometry2?.instanceCount ?? 1,
    firstInstance: callOpts.firstInstance ?? drawOpts.firstInstance ?? 0,
    vertexCount,
    firstVertex,
    indexCount,
    firstIndex,
    baseVertex
  };
}
function stripIndexFormatFor(geometry2) {
  const topology = geometry2?.topology ?? "triangle-list";
  return geometry2?.stripIndexFormat ?? (topology.endsWith("strip") ? geometry2?.indexFormat : void 0);
}
function primitiveState(geometry2, cullMode, frontFace, unclippedDepth) {
  const topology = geometry2?.topology ?? "triangle-list";
  const stripIndexFormat = stripIndexFormatFor(geometry2);
  const state = stripIndexFormat ? { topology, stripIndexFormat } : { topology };
  if (cullMode !== void 0)
    state.cullMode = cullMode;
  if (frontFace !== void 0)
    state.frontFace = frontFace;
  if (unclippedDepth)
    state.unclippedDepth = true;
  return state;
}
function validateDrawInterval(label, kind, first, count, max) {
  if (max === void 0 || first + count <= max)
    return;
  throw meshRangeInvalidError(`${label}.draw`, `${kind} range [${first}, ${first + count}) exceeds parent geometry ${kind} count ${max}.`);
}
function validateOptionalGeometryRange(label, field, value) {
  if (value === void 0 || Number.isInteger(value) && value >= 0)
    return;
  throw meshRangeInvalidError(`${label}.draw`, `${field} must be an integer >= 0; received ${String(value)}.`);
}
function validateOptionalDrawCount(label, field, value) {
  if (value === void 0)
    return;
  if (Number.isInteger(value) && value >= 0)
    return;
  throw new VGPUError2({
    code: "VGPU-R1-DRAW-COUNT",
    message: `${field} of '${label}' must be an integer >= 0; received ${String(value)}. Use 0 only when you want to issue a valid draw with no vertices/instances.`,
    where: `${label}.draw`
  });
}
function normalizeFragmentState(label, opts) {
  const blendState2 = opts.blend === void 0 ? void 0 : normalizeBlend(label, opts.blend);
  const writeMask = opts.writeMask === void 0 ? void 0 : normalizeWriteMask(label, opts.writeMask);
  const colorStates = opts.colors === void 0 ? void 0 : normalizeColorStates(label, opts.colors);
  const fragmentKey = colorStates ? `${fragmentKeyFor(blendState2, writeMask)}@${colorStates.map(colorStateKeyFor).join("@")}` : blendState2 || writeMask !== void 0 ? fragmentKeyFor(blendState2, writeMask) : void 0;
  return { blendState: blendState2, writeMask, colorStates, fragmentKey };
}
function normalizeColorStates(label, value) {
  if (!Array.isArray(value))
    throw colorsInvalidError(label, `colors must be an array; received ${preview(value)}.`);
  return value.map((entry, index) => {
    if (entry === null || entry === void 0)
      return null;
    if (typeof entry !== "object" || Array.isArray(entry))
      throw colorsInvalidError(label, `colors[${index}] must be null or { blend?, writeMask? }; received ${preview(entry)}.`);
    const blendState2 = entry.blend === void 0 ? void 0 : normalizeBlend(`${label}.colors[${index}]`, entry.blend);
    const writeMask = entry.writeMask === void 0 ? void 0 : normalizeWriteMask(`${label}.colors[${index}]`, entry.writeMask);
    if (!blendState2 && writeMask === void 0)
      return null;
    return { blendState: blendState2, writeMask };
  });
}
function normalizeBlend(label, value) {
  if (value === "alpha")
    return blendState({ src: "src-alpha", dst: "one-minus-src-alpha" }, { src: "one", dst: "one-minus-src-alpha" });
  if (value === "premultiplied")
    return blendState({ src: "one", dst: "one-minus-src-alpha" }, { src: "one", dst: "one-minus-src-alpha" });
  if (value === "additive")
    return blendState({ src: "one", dst: "one" }, { src: "one", dst: "one" });
  if (typeof value !== "object" || value === null || !validBlendComponent(value.color))
    throw blendInvalidError(label, value);
  const color = value.color;
  const alpha = value.alpha;
  if (alpha !== void 0 && !validBlendComponent(alpha))
    throw blendInvalidError(label, value);
  return blendState(color, alpha ?? color);
}
function validBlendComponent(value) {
  return typeof value === "object" && value !== null && typeof value.src === "string" && typeof value.dst === "string";
}
function blendState(color, alpha) {
  return { color: blendComponent(color), alpha: blendComponent(alpha) };
}
function blendComponent(component) {
  return { srcFactor: component.src, dstFactor: component.dst, operation: component.op ?? "add" };
}
function normalizeBlendConstantOptions(label, opts, fragmentState) {
  if (opts.blendConstant === void 0)
    return {};
  const value = opts.blendConstant;
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    throw blendConstantInvalidError(label, `received ${preview(value)}; expected [r, g, b, a] finite numbers.`);
  }
  if (!effectiveBlendStates(fragmentState).some((blend) => blend && usesConstantBlendFactor(blend))) {
    throw blendConstantInvalidError(label, `no color target's effective blend uses a "constant"/"one-minus-constant" factor (colors[i].blend replaces the top-level blend for that target), so blendConstant would have no effect.`);
  }
  return { blendConstant: { r: value[0], g: value[1], b: value[2], a: value[3] } };
}
function effectiveBlendStates(fragmentState) {
  if (!fragmentState.colorStates)
    return [fragmentState.blendState];
  return fragmentState.colorStates.map((entry) => entry?.blendState ?? fragmentState.blendState);
}
function usesConstantBlendFactor(blend) {
  return [blend.color.srcFactor, blend.color.dstFactor, blend.alpha.srcFactor, blend.alpha.dstFactor].some((factor) => factor === "constant" || factor === "one-minus-constant");
}
function normalizeEntryOptions(label, value) {
  if (value === void 0)
    return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw entryInvalidError(label, `received ${preview(value)}; expected { vertex?, fragment? } entry point names.`);
  return value;
}
function entryKeyFor(reflection, vertexEntry, fragmentEntry) {
  const firstVertex = reflection.entryPoints.find((entry) => entry.stage === "vertex");
  const firstFragment = reflection.entryPoints.find((entry) => entry.stage === "fragment");
  if (vertexEntry === firstVertex && fragmentEntry === firstFragment)
    return void 0;
  return `en~${vertexEntry?.name ?? ""}~${fragmentEntry?.name ?? ""}`;
}
function normalizePrimitiveOptions(device, label, opts) {
  const cullMode = opts.cull === void 0 ? void 0 : normalizeCull(label, opts.cull);
  const frontFace = opts.frontFace === void 0 ? void 0 : normalizeFrontFace(label, opts.frontFace);
  const unclippedDepth = opts.unclippedDepth === void 0 ? void 0 : normalizeUnclippedDepth(device, label, opts.unclippedDepth);
  return { cullMode, frontFace, unclippedDepth };
}
function normalizeUnclippedDepth(device, label, value) {
  if (typeof value !== "boolean")
    throw unclippedDepthInvalidError(label, `received ${preview(value)}; expected a boolean.`);
  if (!value)
    return void 0;
  if (!device.features.has("depth-clip-control")) {
    throw unclippedDepthInvalidError(label, `the device lacks the "depth-clip-control" feature; request it at init: init({ requiredFeatures: ["depth-clip-control"] }) on an adapter that supports it.`);
  }
  return true;
}
function normalizeCull(label, value) {
  if (value === "none" || value === "front" || value === "back")
    return value;
  throw cullInvalidError(label, value);
}
function normalizeFrontFace(label, value) {
  if (value === "ccw" || value === "cw")
    return value;
  throw frontFaceInvalidError(label, value);
}
var DEFAULT_DEPTH_STATE = { depthWriteEnabled: true, depthCompare: "less-equal" };
var DEPTH_COMPARE_FUNCTIONS = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
var I32_MIN = -2147483648;
var I32_MAX = 2147483647;
function depthStencilState(signature, state) {
  if (!signature.depth)
    return void 0;
  return { format: signature.depth, ...state.depthState ?? DEFAULT_DEPTH_STATE, ...state.stencilState ?? {} };
}
function normalizeDepthOptions(device, label, opts) {
  if (opts.depth === void 0)
    return {};
  const depthState = normalizeDepth(device, label, opts.depth, opts.geometry?.topology ?? "triangle-list");
  return { depthState, depthKey: depthKeyFor(depthState) };
}
function normalizeDepth(device, label, value, topology) {
  if (value === false)
    return { depthWriteEnabled: false, depthCompare: "always" };
  if (typeof value !== "object" || value === null)
    throw depthInvalidError(label, `received ${preview(value)}.`);
  if (value.write !== void 0 && typeof value.write !== "boolean")
    throw depthInvalidError(label, `write must be a boolean; received ${preview(value.write)}.`);
  if (value.compare !== void 0 && !DEPTH_COMPARE_FUNCTIONS.includes(value.compare))
    throw depthInvalidError(label, `compare must be a GPUCompareFunction; received ${preview(value.compare)}.`);
  if (value.bias !== void 0 && !Number.isInteger(value.bias))
    throw depthInvalidError(label, `bias must be an integer (WebGPU depthBias is i32); received ${preview(value.bias)}.`);
  if (value.bias !== void 0 && (value.bias < I32_MIN || value.bias > I32_MAX))
    throw depthInvalidError(label, `bias must fit in the i32 range [${I32_MIN}, ${I32_MAX}] (WebGPU depthBias is i32); received ${preview(value.bias)}.`);
  if (value.biasSlopeScale !== void 0 && !Number.isFinite(value.biasSlopeScale))
    throw depthInvalidError(label, `biasSlopeScale must be a finite number; received ${preview(value.biasSlopeScale)}.`);
  if (value.biasClamp !== void 0 && !Number.isFinite(value.biasClamp))
    throw depthInvalidError(label, `biasClamp must be a finite number; received ${preview(value.biasClamp)}.`);
  const bias = value.bias ?? 0;
  const biasSlopeScale = value.biasSlopeScale ?? 0;
  const biasClamp = value.biasClamp ?? 0;
  if ((bias !== 0 || biasSlopeScale !== 0 || biasClamp !== 0) && !topology.startsWith("triangle"))
    throw depthInvalidError(label, `bias, biasSlopeScale, and biasClamp must be 0 for "${topology}" topology.`);
  if (biasClamp !== 0 && device.isCompatibilityMode)
    throw depthInvalidError(label, `biasClamp must be 0 on a compatibility-mode device; received ${preview(value.biasClamp)}.`);
  return {
    depthWriteEnabled: value.write ?? true,
    depthCompare: value.compare ?? "less-equal",
    ...bias !== 0 ? { depthBias: bias } : {},
    ...biasSlopeScale !== 0 ? { depthBiasSlopeScale: biasSlopeScale } : {},
    ...biasClamp !== 0 ? { depthBiasClamp: biasClamp } : {}
  };
}
function depthKeyFor(state) {
  return `${state.depthWriteEnabled ? 1 : 0}~${state.depthCompare}~${state.depthBias ?? 0}~${state.depthBiasSlopeScale ?? 0}~${state.depthBiasClamp ?? 0}`;
}
var STENCIL_OPERATIONS = ["keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap"];
function normalizeStencilOptions(label, opts) {
  if (opts.stencil === void 0)
    return {};
  const value = opts.stencil;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw stencilInvalidError(label, `received ${preview(value)}; expected { front?, back?, readMask?, writeMask?, ref? }.`);
  const front = value.front === void 0 ? void 0 : normalizeStencilFace(label, "front", value.front);
  const back = value.back === void 0 ? void 0 : normalizeStencilFace(label, "back", value.back);
  validateStencilValue(label, "readMask", value.readMask);
  validateStencilValue(label, "writeMask", value.writeMask);
  validateStencilValue(label, "ref", value.ref);
  const stencilState = {
    ...front ? { stencilFront: front } : {},
    // Omitted back mirrors the normalized front so both faces behave the same; with neither given, both keep the WebGPU defaults.
    ...back ?? front ? { stencilBack: back ?? { ...front } } : {},
    ...value.readMask !== void 0 ? { stencilReadMask: value.readMask } : {},
    ...value.writeMask !== void 0 ? { stencilWriteMask: value.writeMask } : {}
  };
  const hasPipelineState = stencilState.stencilFront !== void 0 || stencilState.stencilBack !== void 0 || stencilState.stencilReadMask !== void 0 || stencilState.stencilWriteMask !== void 0;
  if (!hasPipelineState && value.ref === void 0)
    return {};
  return {
    ...hasPipelineState ? { stencilState, stencilKey: stencilKeyFor(stencilState) } : {},
    // The reference is encoder state (setStencilReference), not pipeline state; it stays out of the pipeline key.
    ...value.ref !== void 0 ? { stencilRef: value.ref } : {}
  };
}
function normalizeStencilFace(label, field, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw stencilInvalidError(label, `${field} must be a { compare?, fail?, depthFail?, pass? } object; received ${preview(value)}.`);
  if (value.compare !== void 0 && !DEPTH_COMPARE_FUNCTIONS.includes(value.compare))
    throw stencilInvalidError(label, `${field}.compare must be a GPUCompareFunction; received ${preview(value.compare)}.`);
  for (const [name, op] of [["fail", value.fail], ["depthFail", value.depthFail], ["pass", value.pass]]) {
    if (op !== void 0 && !STENCIL_OPERATIONS.includes(op))
      throw stencilInvalidError(label, `${field}.${name} must be a GPUStencilOperation; received ${preview(op)}.`);
  }
  return { compare: value.compare ?? "always", failOp: value.fail ?? "keep", depthFailOp: value.depthFail ?? "keep", passOp: value.pass ?? "keep" };
}
function validateStencilValue(label, field, value) {
  if (value === void 0)
    return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw stencilInvalidError(label, `${field} must be an integer in [0, 0xFFFFFFFF] (WebGPU GPUStencilValue is u32); received ${preview(value)}.`);
  }
}
function stencilKeyFor(state) {
  return `st~${stencilFaceKeyFor(state.stencilFront)}~${stencilFaceKeyFor(state.stencilBack)}~${state.stencilReadMask ?? 4294967295}~${state.stencilWriteMask ?? 4294967295}`;
}
function stencilFaceKeyFor(face) {
  if (!face)
    return "default";
  return `${face.compare},${face.failOp},${face.depthFailOp},${face.passOp}`;
}
function multisampleStateFor(signature, state) {
  return { count: signature.sampleCount ?? 1, ...state.multisampleState ?? {} };
}
function normalizeMultisampleOptions(label, opts) {
  if (opts.multisample === void 0)
    return {};
  const value = opts.multisample;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw multisampleInvalidError(label, `received ${preview(value)}; expected { alphaToCoverage?, mask? }.`);
  if (value.alphaToCoverage !== void 0 && typeof value.alphaToCoverage !== "boolean")
    throw multisampleInvalidError(label, `alphaToCoverage must be a boolean; received ${preview(value.alphaToCoverage)}.`);
  if (value.mask !== void 0 && (typeof value.mask !== "number" || !Number.isInteger(value.mask) || value.mask < 0 || value.mask > 4294967295)) {
    throw multisampleInvalidError(label, `mask must be an integer in [0, 0xFFFFFFFF] (WebGPU GPUSampleMask is u32); received ${preview(value.mask)}.`);
  }
  const multisampleState = {
    ...value.alphaToCoverage !== void 0 ? { alphaToCoverageEnabled: value.alphaToCoverage } : {},
    ...value.mask !== void 0 ? { mask: value.mask } : {}
  };
  if (multisampleState.alphaToCoverageEnabled === void 0 && multisampleState.mask === void 0)
    return {};
  return { multisampleState, multisampleKey: multisampleKeyFor(multisampleState) };
}
function multisampleKeyFor(state) {
  return `ms~${state.alphaToCoverageEnabled ? 1 : 0}~${state.mask ?? 4294967295}`;
}
function normalizeWriteMask(label, value) {
  if (!Array.isArray(value))
    throw writeMaskInvalidError(label, preview(value));
  let mask2 = 0;
  for (const channel of value) {
    if (channel === "r")
      mask2 |= 1;
    else if (channel === "g")
      mask2 |= 2;
    else if (channel === "b")
      mask2 |= 4;
    else if (channel === "a")
      mask2 |= 8;
    else
      throw writeMaskInvalidError(label, preview(channel));
  }
  return mask2;
}
function fragmentKeyFor(blend, mask2) {
  return `${blendKeyFor(blend)};${mask2 ?? 15}`;
}
function blendKeyFor(blend) {
  if (!blend)
    return "none;none";
  const c = blend.color;
  const a = blend.alpha;
  return `${c.srcFactor},${c.dstFactor},${c.operation};${a.srcFactor},${a.dstFactor},${a.operation}`;
}
function colorStateKeyFor(state) {
  if (!state)
    return "inherit";
  return `${state.blendState ? blendKeyFor(state.blendState) : "inherit"};${state.writeMask ?? "inherit"}`;
}
function preview(value) {
  if (typeof value === "string")
    return `"${value}"`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function drawWritesDepth(draw2) {
  return (drawState(draw2).depthState ?? DEFAULT_DEPTH_STATE).depthWriteEnabled;
}
function drawStencilWritingOps(draw2) {
  const state = drawState(draw2);
  const stencil = state.stencilState;
  if (!stencil || stencil.stencilWriteMask === 0)
    return [];
  const cullMode = state.cullMode ?? "none";
  const ops = [];
  const collect = (faceName, face) => {
    if (!face)
      return;
    for (const [name, op] of [["fail", face.failOp], ["depthFail", face.depthFailOp], ["pass", face.passOp]]) {
      if (op !== void 0 && op !== "keep")
        ops.push(`${faceName}.${name}: "${op}"`);
    }
  };
  if (cullMode !== "front")
    collect("front", stencil.stencilFront);
  if (cullMode !== "back")
    collect("back", stencil.stencilBack);
  return ops;
}
function encodeDraw(draw2, pass, target2, opts = {}, claimValidation) {
  draw2.encode(pass, target2, opts, claimValidation);
}
function drawState(draw2) {
  const state = drawStates.get(draw2);
  if (!state)
    throw new TypeError("Invalid Draw instance");
  return state;
}
function reportDrawValidationError(state, label, group, cause) {
  const delivery = (async () => {
    await submittedWorkDone(state.device);
    assertDeviceUsable(state.device, `${label}.validation`);
    const error = claimedGroupNativeValidationError(label, group, cause);
    if (state.errorSink)
      await state.errorSink(error);
    else
      console.error(error);
  })();
  state.trackSettled?.(delivery);
  return delivery;
}
function createBundleRegistry() {
  const set = /* @__PURE__ */ new Set();
  return {
    add(bundle) {
      set.add(bundle);
    },
    delete(bundle) {
      set.delete(bundle);
    },
    list() {
      return [...set];
    },
    markStale(event) {
      for (const bundle of set)
        bundle.markStale(event);
    }
  };
}
function offsetsForGroup(offsets, group, fallback) {
  if (!offsets)
    return fallback;
  if (Array.isArray(offsets))
    return offsets;
  const byGroup = offsets;
  return byGroup[group] ?? fallback;
}
function dynamicEntries(draw2, group) {
  const state = drawState(draw2);
  return bindGroupLayoutEntriesForGroup(state.reflection.bindings, group, state.visibility).map(dynamicEntry);
}
function dynamicEntry(entry) {
  if (!entry.buffer)
    return entry;
  return { ...entry, buffer: { ...entry.buffer, hasDynamicOffset: true } };
}
function assertSurfaceTargetInFrame(target2, where) {
  if (isSurface(target2) && !isFrameActive())
    throw surfaceNotInFrameError(where);
}

// node_modules/vgpu/dist/effect.js
function effect(gpu, source, opts = {}) {
  if ("geometry" in opts)
    throw unsupportedError("effect", "effect() never accepts vertex buffers; use draw(gpu, { shader, geometry: geometry(gpu, descriptor) }).");
  const kernel = liveKernel(gpu, "effect");
  const render = renderService(kernel);
  return new InternalEffect(kernel.device, toWgsl(source), opts, render.binds, void 0, render.pipelines, render.shaderModules, render.pipelineLayouts, (error) => kernel.reportError(error), (promise) => {
    void kernel.trackDelivery(promise);
  });
}
var effectImpls = /* @__PURE__ */ new WeakMap();
var InternalEffect = class {
  get gpu() {
    return effectImpl(this).gpu;
  }
  constructor(device, source, opts = {}, cache2, defaultTarget, pipelineStore, shaderModules, pipelineLayouts, errorSink, trackSettled) {
    const shader = fullscreenSource(source);
    const impl = new InternalDraw(device, shader, { shader, set: opts.set, label: opts.label ?? "effect", blend: opts.blend, writeMask: opts.writeMask }, cache2, defaultTarget, pipelineStore, shaderModules, pipelineLayouts, errorSink, trackSettled);
    effectImpls.set(this, impl);
  }
  set(values) {
    effectImpl(this).set(values);
    return this;
  }
  draw(target2 = {}) {
    effectImpl(this).draw(isTarget(target2) ? { target: target2 } : target2);
  }
  compile(target2) {
    return effectImpl(this).compile(target2).then(() => this);
  }
  compileSync(target2) {
    effectImpl(this).compileSync(target2);
    return this;
  }
  /** @internal FramePass delegates here; not part of the frozen public Effect surface. */
  encode(pass, target2, opts = {}, claimValidation) {
    encodeDraw(effectImpl(this), pass, target2, opts, claimValidation);
  }
  /**
   * Frame drawable protocol: an effect is encoded as its underlying draw, so it reuses that draw's
   * protocol object — same encode path, same depth/stencil metadata for read-only passes.
   */
  get [FRAME_DRAWABLE]() {
    return effectImpl(this)[FRAME_DRAWABLE];
  }
};
function effectImpl(effect2) {
  const impl = effectImpls.get(effect2);
  if (!impl)
    throw new TypeError("Invalid Effect instance");
  return impl;
}
function fullscreenSource(source) {
  if (hasVertexEntry(source))
    return source;
  return `
struct VgpuFullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vgpu_fullscreen_vs(@builtin(vertex_index) vi: u32) -> VgpuFullscreenVertexOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var out: VgpuFullscreenVertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
${source}`;
}
function hasVertexEntry(source) {
  return reflectSource(source, "effect.wgsl").entryPoints.some((entry) => entry.stage === "vertex");
}

// node_modules/vgpu/dist/clock.js
var clockToken = serviceToken("clock");
function clock(gpu) {
  return createClock(liveKernel(gpu, "clock"));
}
function createClock(kernel) {
  return kernel.service(clockToken, (self) => {
    const state = frameState(self);
    const assertLive = (where) => {
      if (self.disposed)
        throw gpuDisposedError(where);
      assertDeviceUsable(self.device, where);
    };
    return {
      get time() {
        assertLive("clock.time");
        return state.time;
      },
      get deltaTime() {
        assertLive("clock.deltaTime");
        return state.deltaTime;
      },
      get frameCount() {
        assertLive("clock.frameCount");
        return state.frameCount;
      },
      advance(dtSeconds) {
        assertLive("clock.advance");
        if (typeof dtSeconds !== "number" || !Number.isFinite(dtSeconds) || dtSeconds < 0)
          throw clockDeltaInvalidError(dtSeconds);
        state.advanceBy(dtSeconds);
      }
    };
  });
}

// node_modules/vgpu/dist/frame.js
function frame(gpu, cb) {
  return frameRunner(liveKernel(gpu, "frame")).frame(cb);
}
function frameLoop(gpu, cb, opts = {}) {
  return frameRunner(liveKernel(gpu, "frameLoop")).loop(cb, opts);
}
var frameIsOpen;
var frameRunnerToken = serviceToken("frame-runner");
function frameRunner(kernel) {
  return kernel.service(frameRunnerToken, (self) => {
    const state = frameState(self);
    return new FrameRunner(() => {
      let release = () => {
      };
      const frame2 = new Frame(self.device, void 0, (error) => self.reportError(error), (promise) => {
        void self.trackDelivery(promise);
      }, () => release());
      release = self.own("scheduler", () => frame2.cancel());
      return frame2;
    }, () => state.tick(), (handle) => self.own("scheduler", () => handle.stop()));
  });
}
var Frame = class {
  device;
  defaultTarget;
  errorSink;
  trackSettled;
  releaseLifecycle;
  /**
   * Resolves after submitted GPU work completes and raw claimed-bind-group
   * validation has been delivered to `gpu.onError`.
   *
   * This is a completion/timing signal only; it never rejects and is not an error
   * channel.
   */
  done = Promise.resolve();
  #encoder;
  #validations = [];
  /**
   * Everything a pass of this frame attached, as opaque {@link FrameOwner}s: timers and
   * visibilities today, scene view generations later. The frame never learns what they are — it
   * only guarantees each one sees exactly one `frameSubmitted` or `frameAbandoned`.
   */
  #owners = /* @__PURE__ */ new Set();
  /**
   * Owners whose per-frame bookkeeping a failed pass invalidated: their frame is neither finalized
   * nor read back, so a throwing pass callback cannot leave a phantom result. Kept alongside the
   * live set so a later pass re-attaching the same instance in this frame stays dropped too — the
   * failed pass's span/slots are still in that instance's frame bookkeeping.
   */
  #discardedOwners = /* @__PURE__ */ new Set();
  #submitted = false;
  #canceled = false;
  #passActive = false;
  static {
    frameIsOpen = (frame2) => !(#submitted in frame2) || !frame2.#submitted && !frame2.#canceled;
  }
  constructor(device, defaultTarget, errorSink, trackSettled, releaseLifecycle) {
    this.device = device;
    this.defaultTarget = defaultTarget;
    this.errorSink = errorSink;
    this.trackSettled = trackSettled;
    this.releaseLifecycle = releaseLifecycle;
    assertDeviceUsable(device, "Frame.constructor");
    this.#encoder = device.gpu.createCommandEncoder({ label: "vgpu.frame" });
  }
  pass(target2, body) {
    if (this.#canceled)
      throw frameCanceledError("Frame.pass");
    assertDeviceUsable(this.device, "Frame.pass");
    const targetOnly = isTarget(target2);
    const cb = typeof body === "function" ? body : (p) => p.draw(body);
    const resolvedTarget = targetOnly ? target2 : target2.target ?? this.defaultTarget;
    if (!resolvedTarget)
      throw targetRequiredError("Frame.pass");
    if (isSurface(resolvedTarget) && this.#submitted)
      throw surfaceNotInFrameError("Frame.pass");
    const clear = targetOnly ? void 0 : target2.clear;
    const preserve = clear === false;
    if (preserve && resolvedTarget.sampleCount === 4)
      throw passPreserveMsaaError();
    const clearDepth = targetOnly ? void 0 : target2.clearDepth;
    if (clearDepth !== void 0) {
      if (typeof clearDepth !== "number" || !(clearDepth >= 0 && clearDepth <= 1))
        throw passClearDepthInvalidError(clearDepth);
      if (preserve)
        throw passPreserveClearDepthError();
      if (!resolvedTarget.depth) {
        throw passClearDepthInvalidError(clearDepth, "but the target has no depth attachment, so clearDepth would have no effect.", "Create the target with depth: true (or a depth format), or drop clearDepth.");
      }
    }
    const clearStencil = targetOnly ? void 0 : target2.clearStencil;
    if (clearStencil !== void 0) {
      if (typeof clearStencil !== "number" || !Number.isInteger(clearStencil) || clearStencil < 0 || clearStencil > 4294967295) {
        throw passClearStencilInvalidError(`received ${String(clearStencil)}; expected an integer in [0, 0xFFFFFFFF] (WebGPU GPUStencilValue).`);
      }
      if (preserve)
        throw passPreserveClearStencilError();
      const depthFormat = resolvedTarget.depth?.format;
      if (!hasStencilAspect(depthFormat))
        throw passClearStencilInvalidError(`received ${String(clearStencil)}, but the target's depth format ${depthFormat ? `"${depthFormat}"` : "(none)"} has no stencil aspect, so clearStencil would have no effect.`);
    }
    const depthReadOnly = targetOnly ? void 0 : target2.depthReadOnly;
    if (depthReadOnly !== void 0 && typeof depthReadOnly !== "boolean") {
      throw passDepthReadOnlyError(`received ${previewValue(depthReadOnly)}; expected a boolean.`, "Pass depthReadOnly: true to open the pass with a read-only depth attachment, or omit it.");
    }
    if (depthReadOnly) {
      if (!resolvedTarget.depth)
        throw passDepthReadOnlyError("is set, but the target has no depth attachment, so there is nothing to make read-only.", "Create the target with depth: true (or a depth format), or drop depthReadOnly.");
      if (resolvedTarget.sampleCount === 4)
        throw passDepthReadOnlyMsaaError();
      if (clearDepth !== void 0)
        throw passDepthReadOnlyError("cannot be combined with clearDepth; a read-only depth aspect omits its load/store ops and is never cleared.", "Remove clearDepth, or drop depthReadOnly.");
      if (clearStencil !== void 0)
        throw passDepthReadOnlyError("cannot be combined with clearStencil; a read-only stencil aspect omits its load/store ops and is never cleared.", "Remove clearStencil, or drop depthReadOnly.");
    }
    const viewport = targetOnly ? void 0 : validatedViewport(target2.viewport, this.device.gpu.limits, resolvedTarget.size);
    const scissor = targetOnly ? void 0 : validatedScissor(target2.scissor, resolvedTarget.size);
    const attached = [];
    let encoder;
    try {
      const timer = targetOnly || target2.timer === void 0 ? void 0 : this.#attach(target2.timer, resolvedTarget, attached, timerAttachmentInvalidError);
      const visibility = targetOnly || target2.visibility === void 0 ? void 0 : this.#attach(target2.visibility, resolvedTarget, attached, visibilityAttachmentInvalidError);
      const occlusion = visibility?.occlusion;
      let descriptor = resolvedTarget.renderPassDescriptor({ clear: clear === void 0 || clear === true || clear === false ? resolvedTarget.clearColor ?? BUILT_IN_CLEAR_COLOR : clear, preserve, clearDepth, clearStencil, depthReadOnly });
      if (timer?.timestampWrites)
        descriptor = { ...descriptor, timestampWrites: timer.timestampWrites };
      if (occlusion)
        descriptor = { ...descriptor, occlusionQuerySet: occlusion.querySet };
      encoder = this.#encoder.beginRenderPass(descriptor);
      if (viewport)
        encoder.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.minDepth, viewport.maxDepth);
      if (scissor)
        encoder.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
      this.#passActive = true;
      try {
        cb(new FramePass(encoder, resolvedTarget, this.#validations, depthReadOnly === true, occlusion, this, (where) => {
          assertDeviceUsable(this.device, where);
          if (this.#canceled)
            throw frameCanceledError(where);
        }));
      } finally {
        this.#passActive = false;
      }
    } catch (error) {
      this.#discardOwners(attached);
      discardClaimedGroupValidationResults(this.#validations);
      this.#validations.length = 0;
      discardClaimedGroupValidationScopes(this.device);
      try {
        encoder?.end();
      } catch {
      }
      throw error;
    }
    endRenderPassWithClaimValidation(this.device, encoder, this.#validations);
  }
  submit() {
    if (this.#submitted || this.#canceled)
      return;
    assertDeviceUsable(this.device, "Frame.submit");
    this.#submitted = true;
    this.releaseLifecycle?.();
    for (const owner of this.#liveOwners())
      owner.finalizeFrame(this, this.#encoder);
    let commandBuffer;
    const finishContext = this.#validations[0]?.context;
    if (finishContext)
      pushClaimedGroupValidationScope(this.device, finishContext);
    try {
      commandBuffer = this.#encoder.finish();
    } catch (error) {
      this.#abandonOwners(this.#frameOwners());
      const result = finishContext ? popLastClaimedGroupValidationScope(this.device) : void 0;
      discardClaimedGroupValidationResults(this.#validations);
      if (result)
        discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? finishContext;
      if (!context)
        throw error;
      this.done = this.#trackDone(this.#deliverValidationError(context.label, context.group, error));
      return;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result)
        this.#validations[0] = this.#validations[0] ? preferClaimedGroupValidationResult(result, this.#validations[0]) : result;
    }
    const submitContext = this.#validations[0]?.context;
    if (submitContext)
      pushClaimedGroupValidationScope(this.device, submitContext);
    try {
      this.device.gpu.queue.submit([commandBuffer]);
    } catch (error) {
      this.#abandonOwners(this.#frameOwners());
      const result = submitContext ? popLastClaimedGroupValidationScope(this.device) : void 0;
      discardClaimedGroupValidationResults(this.#validations);
      if (result)
        discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (!context)
        throw error;
      this.done = this.#trackDone(this.#deliverValidationError(context.label, context.group, error));
      return;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result)
        this.#validations[0] = this.#validations[0] ? preferClaimedGroupValidationResult(result, this.#validations[0]) : result;
    }
    for (const owner of this.#liveOwners())
      owner.frameSubmitted(this);
    this.#abandonOwners(this.#discardedOwners);
    this.done = this.#trackDone(claimedGroupValidationDone(this.device, this.#validations, { errorSink: this.errorSink }));
  }
  /**
   * Discards the frame without submitting it: the command encoder is dropped (nothing this frame
   * encoded ever runs) and every telemetry instance it attached releases the retain it took on its
   * query ring, so a `timer(gpu)` / `visibility(gpu)` can be disposed for good without waiting for
   * `gpu.dispose()`. This is the explicit way out of the leak a manual `frame(gpu)` would otherwise
   * hold: a frame is never assumed abandoned, because an old frame can still be submitted.
   *
   * Idempotent, like `submit()`: cancelling twice is a no-op, and `submit()` after `cancel()` does
   * nothing. Cancelling a frame that was already submitted throws `VGPU-FRAME-SUBMITTED` — its work
   * is on the queue and cannot be taken back, so silently accepting the call would hide a real
   * lifecycle bug.
   */
  cancel() {
    if (this.#canceled)
      return;
    if (this.#submitted)
      throw frameAlreadySubmittedError("Frame.cancel");
    if (this.#passActive)
      throw framePassActiveError("Frame.cancel");
    this.#canceled = true;
    this.releaseLifecycle?.();
    this.#abandonOwners(this.#frameOwners());
    this.#owners.clear();
    this.#discardedOwners.clear();
    discardClaimedGroupValidationResults(this.#validations);
    this.#validations.length = 0;
  }
  /**
   * Ends the frame for telemetry instances that will never see a real frameSubmitted: a pass whose
   * callback threw, a frame whose finish/submit failed, or a canceled frame. Each one took a retain
   * on its query ring when it was attached to a pass descriptor (so a mid-frame dispose() cannot
   * destroy a set the frame still points at); without the matching release, a dispose() after the
   * failure leaves the ring alive forever. frameAbandoned() drops the instance's pending encoded
   * state as it releases: a resolve that never reached the queue must not be decoded — its staging
   * buffer holds stale bytes, which would surface as a phantom duration or a phantom "hidden".
   */
  #abandonOwners(owners) {
    for (const owner of [...owners])
      owner.frameAbandoned(this);
  }
  /** Every owner this frame attached, discarded ones included. */
  #frameOwners() {
    return [...this.#owners, ...this.#discardedOwners];
  }
  /** Moves owners out of this frame's live set: they are neither finalized nor read back. */
  #discardOwners(owners) {
    for (const owner of [...owners]) {
      this.#owners.delete(owner);
      this.#discardedOwners.add(owner);
    }
  }
  #liveOwners() {
    return [...this.#owners].filter((owner) => !this.#discardedOwners.has(owner));
  }
  /**
   * Attaches one `FramePassOptions` telemetry value to this pass through the nominal attachment
   * protocol, so the frame never learns whether it is a timer span, a visibility or a future
   * scene-view generation: it only records the owner it must settle exactly once.
   */
  #attach(value, target2, attached, invalid) {
    const attachment = framePassAttachmentOf(value);
    if (!attachment)
      throw invalid(value);
    let result;
    try {
      result = attachment[FRAME_PASS_ATTACHMENT]({ frame: this, device: this.device, target: target2 });
    } catch (error) {
      this.#discardOwners(this.#owners);
      throw error;
    }
    this.#owners.add(result.owner);
    attached.push(result.owner);
    return result;
  }
  async #deliverValidationError(label, group, cause) {
    await submittedWorkDone(this.device);
    assertDeviceUsable(this.device, "Frame.validation");
    const error = claimedGroupNativeValidationError(label, group, cause);
    if (this.errorSink)
      await this.errorSink(error);
    else
      console.error(error);
  }
  #trackDone(promise) {
    this.trackSettled?.(promise);
    return promise;
  }
};
var FramePass = class {
  encoder;
  target;
  validations;
  depthReadOnly;
  occlusionSource;
  frame;
  assertFrameOpen;
  #occlusionActive = false;
  constructor(encoder, target2, validations, depthReadOnly = false, occlusionSource, frame2, assertFrameOpen) {
    this.encoder = encoder;
    this.target = target2;
    this.validations = validations;
    this.depthReadOnly = depthReadOnly;
    this.occlusionSource = occlusionSource;
    this.frame = frame2;
    this.assertFrameOpen = assertFrameOpen;
  }
  draw(drawable, opts = {}) {
    this.assertFrameOpen?.("FramePass.draw");
    const encodable = frameDrawable(drawable);
    if (this.depthReadOnly)
      assertDrawableAllowedInReadOnlyPass(encodable, this.target);
    encodable.encode(this.encoder, this.target, opts, (result) => this.validations.push(result));
  }
  /**
   * Wraps one or more draws in begin/endOcclusionQuery. The body ALWAYS executes; condition your
   * real draws on `q.hidden` outside.
   */
  occlusion(query, body) {
    this.assertFrameOpen?.("FramePass.occlusion");
    if (!this.occlusionSource)
      throw queryNoVisibilityError();
    if (this.#occlusionActive)
      throw queryNestedError();
    const index = this.occlusionSource.beginQuery(query, this.frame);
    this.encoder.beginOcclusionQuery(index);
    this.#occlusionActive = true;
    try {
      if (typeof body === "function")
        body();
      else
        this.draw(body);
    } finally {
      this.#occlusionActive = false;
      this.encoder.endOcclusionQuery();
    }
  }
  bundles(...bundles) {
    this.assertFrameOpen?.("FramePass.bundles");
    if (this.depthReadOnly)
      throw passDepthReadOnlyError("pass cannot replay bundles: bundle records bundles with writable depth/stencil, and WebGPU only executes read-only-recorded bundles in a read-only pass.", "Encode the draws directly with pass.draw(...) inside the depthReadOnly pass.", "FramePass.bundles");
    const recorded = bundles.map((entry) => frameBundleOf(entry) ?? invalidBundle());
    for (const entry of recorded)
      entry.assertReplayable(this.target);
    this.encoder.executeBundles(recorded.map((entry) => entry.gpu));
  }
};
function assertDrawableAllowedInReadOnlyPass(drawable, target2) {
  if (drawable.writesDepth()) {
    throw passDepthReadOnlyError(`pass cannot encode draw '${drawable.label}': its depth state writes depth (the default is write: true). Give the draw depth: { write: false } (or depth: false to disable depth testing).`, "Use depth: { write: false } on the draw, or open the pass without depthReadOnly.", "FramePass.draw");
  }
  if (hasStencilAspect(target2.depth?.format)) {
    const ops = drawable.stencilWritingOps();
    if (ops.length) {
      throw passDepthReadOnlyError(`pass cannot encode draw '${drawable.label}': its stencil ops can write (${ops.join(", ")}), and the pass's stencil aspect is read-only too.`, `Use "keep" for those ops or stencil writeMask: 0, or open the pass without depthReadOnly.`, "FramePass.draw");
    }
  }
}
function frameDrawable(drawable) {
  const encodable = frameDrawableOf(drawable);
  if (!encodable)
    throw new TypeError("Invalid Effect instance: pass.draw() expects a Draw or an Effect created by this library.");
  return encodable;
}
function invalidBundle() {
  throw new VGPUError2({ code: "VGPU-R3-BUNDLE-INVALID", message: "p.bundles() expected bundles created by bundle(gpu, { target }, cb).", where: "FramePass.bundles" });
}
function timerAttachmentInvalidError(value) {
  return timerInvalidError(`FramePassOptions.timer received ${previewValue(value)}; expected a TimerSpan from timer.span(name).`, `Create const passTimer = timer(gpu) once, then pass passTimer.span("name") per pass.`, "Frame.pass");
}
function visibilityAttachmentInvalidError(value) {
  return visibilityInvalidError(`FramePassOptions.visibility received ${previewValue(value)}; expected a Visibility from visibility(gpu).`, "Create const vis = visibility(gpu) once, then pass { target, visibility: vis } per pass.", "Frame.pass");
}
function validatedViewport(viewport, limits, targetSize) {
  if (viewport === void 0)
    return void 0;
  if (typeof viewport !== "object" || viewport === null || Array.isArray(viewport))
    throw passViewportInvalidError(`received ${previewValue(viewport)}; expected { x?, y?, width, height, minDepth?, maxDepth? }.`);
  const { x = 0, y = 0, width, height, minDepth = 0, maxDepth = 1 } = viewport;
  for (const [name, value] of [["x", x], ["y", y], ["width", width], ["height", height], ["minDepth", minDepth], ["maxDepth", maxDepth]]) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw passViewportInvalidError(`${name} received ${previewValue(value)}; expected a finite number.`);
  }
  const max = limits.maxTextureDimension2D;
  const maxViewportRange = max * 2;
  const sizeNote = `target is ${targetSize[0]}x${targetSize[1]}px, device maxTextureDimension2D is ${max}`;
  if (!(width >= 0 && width <= max))
    throw passViewportInvalidError(`width ${width} is outside [0, ${max}] (${sizeNote}).`);
  if (!(height >= 0 && height <= max))
    throw passViewportInvalidError(`height ${height} is outside [0, ${max}] (${sizeNote}).`);
  if (!(x >= -maxViewportRange && x + width <= maxViewportRange - 1))
    throw passViewportInvalidError(`x ${x} with width ${width} is outside [${-maxViewportRange}, ${maxViewportRange - 1}] (${sizeNote}).`);
  if (!(y >= -maxViewportRange && y + height <= maxViewportRange - 1))
    throw passViewportInvalidError(`y ${y} with height ${height} is outside [${-maxViewportRange}, ${maxViewportRange - 1}] (${sizeNote}).`);
  if (!(minDepth >= 0 && minDepth <= 1))
    throw passViewportInvalidError(`minDepth ${minDepth} is outside [0, 1].`);
  if (!(maxDepth >= 0 && maxDepth <= 1))
    throw passViewportInvalidError(`maxDepth ${maxDepth} is outside [0, 1].`);
  if (!(minDepth <= maxDepth))
    throw passViewportInvalidError(`minDepth ${minDepth} exceeds maxDepth ${maxDepth}.`);
  return { x, y, width, height, minDepth, maxDepth };
}
function validatedScissor(scissor, targetSize) {
  if (scissor === void 0)
    return void 0;
  if (!Array.isArray(scissor) || scissor.length !== 4)
    throw passScissorInvalidError(`received ${previewValue(scissor)}; expected [x, y, width, height].`);
  const [x, y, width, height] = scissor;
  for (const [name, value] of [["x", x], ["y", y], ["width", width], ["height", height]]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw passScissorInvalidError(`${name} received ${previewValue(value)}; expected a non-negative integer.`);
  }
  const [targetWidth, targetHeight] = targetSize;
  if (x + width > targetWidth || y + height > targetHeight) {
    throw passScissorInvalidError(`[${x}, ${y}, ${width}, ${height}] exceeds the target's current size ${targetWidth}x${targetHeight}px (x + width <= ${targetWidth}, y + height <= ${targetHeight}).`);
  }
  return [x, y, width, height];
}
function previewValue(value) {
  if (typeof value === "string")
    return `'${value}'`;
  if (Array.isArray(value))
    return `[${value.map((entry) => previewValue(entry)).join(", ")}]`;
  if (typeof value === "object" && value !== null)
    return "an object";
  return String(value);
}
function isDeviceGoneError(error) {
  const code = error?.code;
  return code === "VGPU-DEVICE-DISPOSED" || code === "VGPU-DEVICE-LOST";
}
var FrameRunner = class {
  createFrame;
  advance;
  trackLoop;
  #running = false;
  /**
   * @param trackLoop Lifecycle hook for the owning gpu: called with each started loop handle and
   * returns the untrack function the handle runs when it stops on its own, so `gpu.dispose()` can
   * stop the loops still running without holding on to the ones already stopped.
   */
  constructor(createFrame, advance, trackLoop) {
    this.createFrame = createFrame;
    this.advance = advance;
    this.trackLoop = trackLoop;
  }
  frame(cb) {
    if (this.#running || isSurfaceResizeCallbackActive())
      throw frameReentrantError();
    this.#running = true;
    enterFrame();
    try {
      this.advance();
      const frame2 = this.createFrame();
      if (cb) {
        try {
          cb(frame2);
        } catch (error) {
          if (frameIsOpen(frame2)) {
            try {
              frame2.cancel();
            } catch {
            }
          }
          throw error;
        }
        try {
          frame2.submit();
        } catch (error) {
          if (!isDeviceGoneError(error))
            throw error;
        }
      }
      return frame2;
    } finally {
      leaveFrame();
      this.#running = false;
    }
  }
  loop(cb, opts = {}) {
    let stopped = false;
    const request = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(() => fn(performance.now()), 16));
    const cancel = globalThis.cancelAnimationFrame ?? ((id2) => clearTimeout(id2));
    const minIntervalMs = opts.fps && opts.fps > 0 ? 1e3 / opts.fps : 0;
    let lastFrameMs;
    let id = 0;
    let untrack;
    const stop = () => {
      stopped = true;
      cancel(id);
      untrack?.();
      untrack = void 0;
    };
    const tick = (timestamp) => {
      if (stopped)
        return;
      if (shouldRunFrame(timestamp, lastFrameMs, minIntervalMs)) {
        lastFrameMs = timestamp;
        try {
          this.frame(cb);
        } catch (error) {
          stop();
          throw error;
        }
      }
      if (!stopped)
        id = request(tick);
    };
    id = request(tick);
    const handle = { stop };
    untrack = this.trackLoop?.(handle);
    return handle;
  }
};
var FRAME_INTERVAL_SLACK_MS = 1;
function shouldRunFrame(timestamp, lastFrameMs, minIntervalMs) {
  if (lastFrameMs === void 0)
    return true;
  if (minIntervalMs <= 0)
    return true;
  return timestamp - lastFrameMs >= minIntervalMs - FRAME_INTERVAL_SLACK_MS;
}

// node_modules/vgpu/dist/target-offscreen.js
function destroyTextures(textures) {
  const errors = [];
  for (const texture2 of textures) {
    try {
      texture2.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw errors[0];
}
function target(gpu, opts) {
  return new OffscreenTarget(liveKernel(gpu, "target").device, opts);
}
var OffscreenTarget = class {
  device;
  resourceIdentity = createResourceIdentity("render-target");
  #destroySignal = new DestroySignal();
  #texturesRecreatedCallbacks = /* @__PURE__ */ new Set();
  #currentSize;
  #attachments;
  #clearColor;
  #destroyed = false;
  #replacing = false;
  options;
  constructor(device, options) {
    this.device = device;
    validateTargetOptions(options, device);
    this.options = Object.freeze({
      ...options,
      size: Object.freeze([...options.size]),
      ...options.colors ? { colors: Object.freeze(options.colors.map((color) => Object.freeze({ ...color }))) } : {}
    });
    this.#clearColor = options.clearColor === void 0 ? BUILT_IN_CLEAR_COLOR : validateClearColor(options.clearColor, "target.clearColor");
    this.#currentSize = this.options.size;
    this.#attachments = this.#allocateTextures(this.#currentSize);
  }
  get gpu() {
    return this.color.gpu;
  }
  get size() {
    return this.#currentSize;
  }
  get texelSize() {
    return [1 / this.#currentSize[0], 1 / this.#currentSize[1]];
  }
  /** Resolved, sampleable color texture. For MSAA targets, render passes resolve into this texture. */
  get color() {
    return this.#attachments.colors[0];
  }
  /** Resolved, sampleable color textures. For MSAA targets, render passes resolve into these textures. */
  get colors() {
    return this.#attachments.colors;
  }
  get depth() {
    return this.#attachments.depth;
  }
  get format() {
    return colorSpecsFor(this.options)[0]?.format ?? "rgba8unorm";
  }
  /** Default clear color of this target; passes that clear without naming a color use it. */
  get clearColor() {
    return copyClearColor(this.#clearColor);
  }
  set clearColor(value) {
    this.#clearColor = validateClearColor(value, "target.clearColor");
  }
  get sampleCount() {
    return sampleCountFor(this.options);
  }
  resize(size) {
    this.#assertAlive("Target.resize");
    if (this.#replacing)
      throw new VGPUError2({ code: "VGPU-TARGET-RESIZE-REENTRANT", message: "Cannot resize a target from its replacement callbacks.", where: "Target.resize" });
    validateTargetOptions({ ...this.options, size }, this.device);
    if (sameSize(this.#currentSize, size))
      return;
    this.#replacing = true;
    try {
      const nextSize = Object.freeze([...size]);
      const next = this.#allocateTextures(nextSize);
      const previous = this.#attachments;
      this.#currentSize = nextSize;
      this.#attachments = next;
      try {
        this.#emitTexturesRecreated();
      } finally {
        destroyTextures(previous.all);
      }
    } finally {
      this.#replacing = false;
    }
  }
  onDestroy(cb) {
    return this.#destroySignal.onDestroy(this, cb);
  }
  onTexturesRecreated(cb) {
    this.#assertAlive("Target.onTexturesRecreated");
    this.#texturesRecreatedCallbacks.add(cb);
    return () => {
      this.#texturesRecreatedCallbacks.delete(cb);
    };
  }
  destroy() {
    if (this.#destroyed)
      return;
    this.#destroyed = true;
    try {
      this.#destroySignal.emit(this);
    } finally {
      this.#texturesRecreatedCallbacks.clear();
      destroyTextures(this.#attachments.all);
    }
  }
  renderPassDescriptor(opts = {}) {
    this.#assertAlive("Target.renderPassDescriptor");
    const { clear = [0, 0, 0, 1], preserve, clearDepth, clearStencil, depthReadOnly } = opts;
    return {
      colorAttachments: this.colors.map((resolved, index) => colorAttachment(resolved, this.#attachments.msaaColors?.[index], clear, preserve)),
      depthStencilAttachment: this.depth ? depthAttachment(this.depth, preserve, clearDepth, clearStencil, depthReadOnly) : void 0
    };
  }
  #assertAlive(where) {
    if (this.#destroyed)
      throw new VGPUError2({ code: "VGPU-TARGET-DESTROYED", message: `Target '${this.options.label ?? "target"}' is destroyed.`, where, fix: "Create a new target; destroyed targets cannot be resized or rendered." });
    assertDeviceUsable(this.device, where);
  }
  #emitTexturesRecreated() {
    const errors = [];
    for (const cb of [...this.#texturesRecreatedCallbacks]) {
      try {
        cb();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw errors[0];
  }
  #allocateTextures(size) {
    const allocated = [];
    const create = (opts) => {
      const texture2 = this.device.createTexture(opts);
      allocated.push(texture2);
      return texture2;
    };
    try {
      const colors = this.#createResolvedColors(size, create);
      const msaaColors = this.sampleCount === 4 ? this.#createMsaaColors(size, create) : void 0;
      const depth = this.#createDepth(size, create);
      return { colors: Object.freeze(colors), msaaColors: msaaColors && Object.freeze(msaaColors), depth, all: allocated };
    } catch (error) {
      try {
        destroyTextures(allocated);
      } catch {
      }
      throw error;
    }
  }
  #createResolvedColors(size, create) {
    return colorSpecsFor(this.options).map((spec, index) => create({
      kind: "2d",
      size,
      format: spec.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      sampleCount: 1,
      label: this.options.label ? `${this.options.label}.color${index}.resolve` : void 0
    }));
  }
  #createMsaaColors(size, create) {
    return colorSpecsFor(this.options).map((spec, index) => create({
      kind: "2d",
      size,
      format: spec.format,
      usage: ["render_attachment"],
      sampleCount: 4,
      label: this.options.label ? `${this.options.label}.color${index}` : void 0
    }));
  }
  #createDepth(size, create) {
    const format = depthFormatFor(this.options);
    return format ? create({
      kind: "2d",
      size,
      format,
      // texture_binding lets later passes read the depth (fog, occlusion, SSAO) without a copy.
      usage: ["render_attachment", "texture_binding"],
      sampleCount: this.sampleCount,
      label: this.options.label ? `${this.options.label}.depth` : void 0
    }) : void 0;
  }
};

// node_modules/vgpu/dist/texture.js
function texture(gpu, opts) {
  const kernel = liveKernel(gpu, "texture");
  const created = kernel.device.createTexture(opts);
  return ownResource(kernel, created, (owned) => owned.destroy(), (cb) => {
    created.onDestroy(cb);
  });
}

// node_modules/vgpu/dist/index.js
function init(options) {
  return createCoreGpu("browser", options);
}

// node_modules/vgpu/dist/scene/geometry-recipe.js
function recipe(kind, props, generate) {
  const frozen = Object.freeze({ ...props });
  return Object.freeze({
    kind,
    props: frozen,
    build: (device) => meshGeometryOptions(generate(device, frozen))
  });
}
function meshGeometryOptions(primitive) {
  const attrs = primitive.attributes;
  const attributes = {
    position: { ...attrs.position, location: 0 }
  };
  if (attrs.normal)
    attributes.normal = { ...attrs.normal, location: 1 };
  if (attrs.uv)
    attributes.uv = { ...attrs.uv, location: 2 };
  return {
    buffers: [{
      buffer: primitive.gpu?.vertexBuffer ?? primitive.vertexBuffer.gpu,
      stride: attrs.stride,
      attributes
    }],
    vertexCount: primitive.vertexCount,
    indexBuffer: primitive.gpu?.indexBuffer ?? primitive.indexBuffer?.gpu,
    indexFormat: primitive.indexFormat,
    indexCount: primitive.indexCount
  };
}

// node_modules/vgpu/dist/scene/geometry-src/mesh-cache.js
function cachedMesh(cache2, device, key, build) {
  let meshes = cache2.get(device);
  if (!meshes) {
    meshes = /* @__PURE__ */ new Map();
    cache2.set(device, meshes);
  }
  const cached = meshes.get(key);
  if (cached)
    return cached;
  const mesh = build();
  meshes.set(key, mesh);
  return mesh;
}

// node_modules/vgpu/dist/scene/geometry-src/mesh-box.js
var FLOATS_PER_VERTEX = 6;
var VERTEX_COUNT = 36;
var BYTE_STRIDE = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
var ATTRIBUTES = Object.freeze({
  stride: BYTE_STRIDE,
  position: Object.freeze({ offset: 0, format: "float32x3" }),
  normal: Object.freeze({ offset: 12, format: "float32x3" })
});
var cache = /* @__PURE__ */ new WeakMap();
function box(spec) {
  const size = spec.size ?? 1;
  return cachedMesh(cache, spec.device, size, () => {
    const vertices = boxVertices(size);
    const vertexBuffer = spec.device.createBuffer({
      label: `mesh.box.size=${size}`,
      size: vertices.byteLength,
      usage: ["vertex", "copy_dst"]
    });
    vertexBuffer.write(vertices);
    const h = size / 2;
    return Object.freeze({
      vertexBuffer,
      vertexCount: VERTEX_COUNT,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({
        min: new Float32Array([-h, -h, -h]),
        max: new Float32Array([h, h, h])
      }),
      layout: "position-normal",
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu })
    });
  });
}
function boxVertices(size) {
  const h = size / 2;
  const data = [];
  pushFace(data, [h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h], [1, 0, 0]);
  pushFace(data, [-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h], [-1, 0, 0]);
  pushFace(data, [-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h], [0, 1, 0]);
  pushFace(data, [-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h], [0, -1, 0]);
  pushFace(data, [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]);
  pushFace(data, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
  return new Float32Array(data);
}
function pushFace(data, a, b, c, d, normal) {
  pushVertex(data, a, normal);
  pushVertex(data, b, normal);
  pushVertex(data, c, normal);
  pushVertex(data, a, normal);
  pushVertex(data, c, normal);
  pushVertex(data, d, normal);
}
function pushVertex(data, position, normal) {
  data.push(position[0], position[1], position[2], normal[0], normal[1], normal[2]);
}

// node_modules/vgpu/dist/scene/geometry.js
function box2(options = {}) {
  return recipe("box", options, (device, props) => box({ device, ...props }));
}

// node_modules/vgpu/dist/scene/geometry-src/deg-to-rad.js
function degToRad(deg) {
  return deg * Math.PI / 180;
}

// node_modules/vgpu/dist/scene/geometry-src/camera-math.js
function perspective(fov, aspect, near, far) {
  const f = Math.tan(Math.PI * 0.5 - 0.5 * fov);
  const range = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    Number.isFinite(far) ? far * range : -1,
    -1,
    0,
    0,
    Number.isFinite(far) ? far * near * range : -near,
    0
  ]);
}

// node_modules/vgpu/dist/scene/tree/errors.js
function sceneCycleError(where, label) {
  const name = label ? `'${label}'` : "the node";
  return new VGPUError2({
    code: "VGPU-SCENE-CYCLE",
    message: `add() would make ${name} an ancestor of itself.`,
    fix: "Remove the node from the ancestor chain first, or add a different node.",
    where
  });
}
function sceneValueError(where, name, expected) {
  return new VGPUError2({
    code: "VGPU-SCENE-VALUE-INVALID",
    message: `\`${name}\` is invalid; expected ${expected}.`,
    fix: `Pass ${expected} for \`${name}\`.`,
    where
  });
}

// node_modules/vgpu/dist/scene/tree/math.js
function identityMat4(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}
function copyMat4(out, m) {
  out.set(m);
  return out;
}
function composeTrs(out, position, quaternion, scale) {
  const x = quaternion[0], y = quaternion[1], z = quaternion[2], w = quaternion[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale[0], sy = scale[1], sz = scale[2];
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  return out;
}
function multiplyMat4(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset], b1 = b[offset + 1], b2 = b[offset + 2], b3 = b[offset + 3];
    out[offset] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[offset + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[offset + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[offset + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}
function invertAffineMat4(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  const b00 = a11 * a22 - a12 * a21;
  const b01 = a12 * a20 - a10 * a22;
  const b02 = a10 * a21 - a11 * a20;
  const det = a00 * b00 + a01 * b01 + a02 * b02;
  const invDet = det === 0 ? 0 : 1 / det;
  const i00 = b00 * invDet, i10 = b01 * invDet, i20 = b02 * invDet;
  const i01 = (a02 * a21 - a01 * a22) * invDet;
  const i11 = (a00 * a22 - a02 * a20) * invDet;
  const i21 = (a01 * a20 - a00 * a21) * invDet;
  const i02 = (a01 * a12 - a02 * a11) * invDet;
  const i12 = (a02 * a10 - a00 * a12) * invDet;
  const i22 = (a00 * a11 - a01 * a10) * invDet;
  out[0] = i00;
  out[1] = i01;
  out[2] = i02;
  out[3] = 0;
  out[4] = i10;
  out[5] = i11;
  out[6] = i12;
  out[7] = 0;
  out[8] = i20;
  out[9] = i21;
  out[10] = i22;
  out[11] = 0;
  out[12] = -(i00 * tx + i10 * ty + i20 * tz);
  out[13] = -(i01 * tx + i11 * ty + i21 * tz);
  out[14] = -(i02 * tx + i12 * ty + i22 * tz);
  out[15] = 1;
  return out;
}
function transformPoint(out, m, p) {
  const x = p[0], y = p[1], z = p[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
function transformDirection(out, m, v) {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}
function quatFromEuler(out, x, y, z) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  out[0] = s1 * c2 * c3 + c1 * s2 * s3;
  out[1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[3] = c1 * c2 * c3 - s1 * s2 * s3;
  return out;
}
function quatFromBasis(out, m00, m01, m02, m10, m11, m12, m20, m21, m22) {
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s;
    out[0] = (m12 - m21) * s;
    out[1] = (m20 - m02) * s;
    out[2] = (m01 - m10) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m12 - m21) / s;
    out[0] = 0.25 * s;
    out[1] = (m10 + m01) / s;
    out[2] = (m20 + m02) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m20 - m02) / s;
    out[0] = (m10 + m01) / s;
    out[1] = 0.25 * s;
    out[2] = (m21 + m12) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m01 - m10) / s;
    out[0] = (m20 + m02) / s;
    out[1] = (m21 + m12) / s;
    out[2] = 0.25 * s;
  }
  return out;
}
function quatLookAt(out, eye, target2, up) {
  let zx = eye[0] - target2[0], zy = eye[1] - target2[1], zz = eye[2] - target2[2];
  const zLen = Math.hypot(zx, zy, zz);
  if (zLen === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return out;
  }
  zx /= zLen;
  zy /= zLen;
  zz /= zLen;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  let xLen = Math.hypot(xx, xy, xz);
  if (xLen === 0) {
    xx = zz;
    xy = 0;
    xz = -zx;
    xLen = Math.hypot(xx, xy, xz);
    if (xLen === 0) {
      xx = 1;
      xy = 0;
      xz = 0;
      xLen = 1;
    }
  }
  xx /= xLen;
  xy /= xLen;
  xz /= xLen;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return quatFromBasis(out, xx, xy, xz, yx, yy, yz, zx, zy, zz);
}

// node_modules/vgpu/dist/scene/tree/node.js
var UP = new Float32Array([0, 1, 0]);
var TMP_EYE = new Float32Array(3);
var TMP_TARGET = new Float32Array(3);
var TMP_UP = new Float32Array(3);
var TMP_PARENT_INVERSE = new Float32Array(16);
var SceneNode = class {
  kind;
  label;
  visible = true;
  #position = new Float32Array(3);
  #quaternion = new Float32Array([0, 0, 0, 1]);
  #scale = new Float32Array([1, 1, 1]);
  #localMatrix = identityMat4(new Float32Array(16));
  #worldMatrix = identityMat4(new Float32Array(16));
  #worldPosition = new Float32Array(3);
  #localDirty = false;
  #worldDirty = false;
  #parent = null;
  #children = [];
  _worldVersion = 0;
  constructor(kind, options = {}) {
    this.kind = kind;
    this.label = options.label;
    this.#applyTransform(options);
    if (options.children)
      this.add(...options.children);
  }
  /** Updates transform components in place; unspecified components are left untouched. */
  set(values) {
    this.#applyTransform(values);
    return this;
  }
  #applyTransform(values) {
    const where = `${this.label ?? this.kind}.set`;
    let transformTouched = false;
    if (values.position !== void 0) {
      writeVec3(this.#position, values.position, "position", where);
      transformTouched = true;
    }
    if (values.quaternion !== void 0) {
      if (values.quaternion.length !== 4)
        throw sceneValueError(where, "quaternion", "an array of 4 numbers (x, y, z, w)");
      this.#quaternion[0] = values.quaternion[0];
      this.#quaternion[1] = values.quaternion[1];
      this.#quaternion[2] = values.quaternion[2];
      this.#quaternion[3] = values.quaternion[3];
      transformTouched = true;
    } else if (values.rotation !== void 0) {
      if (values.rotation.length !== 3)
        throw sceneValueError(where, "rotation", "an array of 3 Euler angles in radians");
      quatFromEuler(this.#quaternion, values.rotation[0], values.rotation[1], values.rotation[2]);
      transformTouched = true;
    }
    if (values.scale !== void 0) {
      if (typeof values.scale === "number") {
        this.#scale.fill(values.scale);
      } else {
        writeVec3(this.#scale, values.scale, "scale", where);
      }
      transformTouched = true;
    }
    if (values.visible !== void 0)
      this.visible = values.visible;
    if (values.label !== void 0)
      this.label = values.label;
    if (transformTouched)
      this.#markTransformDirty();
  }
  /**
   * Rotates the node so its -Z axis points at a world-space target.
   *
   * The whole computation runs in parent space (the target and up hint are pulled through
   * the parent's affine inverse), which stays exact under non-uniform parent scale: an
   * affine map sends the parent-space ray through the target to the world-space ray through
   * the world target. Extracting a scale-stripped parent rotation instead — as an earlier
   * version did — skews the forward vector whenever the parent scale is anisotropic.
   */
  lookAt(target2, up = UP) {
    const where = `${this.label ?? this.kind}.lookAt`;
    writeVec3(TMP_TARGET, target2, "target", where);
    writeVec3(TMP_UP, up, "up", where);
    TMP_EYE.set(this.#position);
    const parent = this.#parent;
    if (parent) {
      invertAffineMat4(TMP_PARENT_INVERSE, parent.worldMatrix);
      transformPoint(TMP_TARGET, TMP_PARENT_INVERSE, TMP_TARGET);
      transformDirection(TMP_UP, TMP_PARENT_INVERSE, TMP_UP);
    }
    quatLookAt(this.#quaternion, TMP_EYE, TMP_TARGET, TMP_UP);
    this.#markTransformDirty();
    return this;
  }
  /** Adds children, reparenting them if needed. Throws `VGPU-SCENE-CYCLE` on cycles. */
  add(...nodes) {
    const where = `${this.label ?? this.kind}.add`;
    for (const node of nodes) {
      for (let ancestor = this; ancestor; ancestor = ancestor.#parent) {
        if (ancestor === node)
          throw sceneCycleError(where, node.label ?? node.kind);
      }
      if (node.#parent)
        node.#parent.#removeChild(node);
      node.#parent = this;
      this.#children.push(node);
      node.#markWorldDirty();
    }
    return this;
  }
  /** Removes direct children; nodes that are not children are ignored. */
  remove(...nodes) {
    for (const node of nodes) {
      if (node.#parent === this)
        this.#removeChild(node);
    }
    return this;
  }
  /** Detaches this node from its parent, keeping its local transform. */
  removeFromParent() {
    if (this.#parent)
      this.#parent.#removeChild(this);
    return this;
  }
  /** Depth-first visit of this node and all descendants. */
  traverse(visit) {
    visit(this);
    for (const child of this.#children)
      child.traverse(visit);
  }
  get parent() {
    return this.#parent;
  }
  get children() {
    return this.#children;
  }
  /** Local position. Stable array identity; mutate via `set()`. */
  get position() {
    return this.#position;
  }
  /** Local rotation quaternion (x, y, z, w). Stable array identity; mutate via `set()`. */
  get quaternion() {
    return this.#quaternion;
  }
  /** Local scale. Stable array identity; mutate via `set()`. */
  get scale() {
    return this.#scale;
  }
  /** Column-major local TRS matrix, recomputed lazily. Stable array identity. */
  get localMatrix() {
    if (this.#localDirty) {
      composeTrs(this.#localMatrix, this.#position, this.#quaternion, this.#scale);
      this.#localDirty = false;
    }
    return this.#localMatrix;
  }
  /** Column-major world matrix, recomputed lazily for dirty subtrees. Stable array identity. */
  get worldMatrix() {
    if (this.#worldDirty || this.#localDirty) {
      const local = this.localMatrix;
      const parent = this.#parent;
      if (parent) {
        multiplyMat4(this.#worldMatrix, parent.worldMatrix, local);
      } else {
        copyMat4(this.#worldMatrix, local);
      }
      this.#worldDirty = false;
      this._worldVersion++;
    }
    return this.#worldMatrix;
  }
  /** World-space position derived from `worldMatrix`. Stable array identity. */
  get worldPosition() {
    const world = this.worldMatrix;
    this.#worldPosition[0] = world[12];
    this.#worldPosition[1] = world[13];
    this.#worldPosition[2] = world[14];
    return this.#worldPosition;
  }
  #markTransformDirty() {
    this.#localDirty = true;
    this.#markWorldDirty(true);
  }
  #markWorldDirty(force = false) {
    if (this.#worldDirty && !force)
      return;
    this.#worldDirty = true;
    for (const child of this.#children)
      child.#markWorldDirty();
  }
  #removeChild(node) {
    const index = this.#children.indexOf(node);
    if (index >= 0)
      this.#children.splice(index, 1);
    node.#parent = null;
    node.#markWorldDirty(true);
  }
};
function writeVec3(out, value, name, where) {
  if (value.length !== 3)
    throw sceneValueError(where, name, "an array of 3 numbers");
  out[0] = value[0];
  out[1] = value[1];
  out[2] = value[2];
}

// node_modules/vgpu/dist/scene/camera.js
var CameraNode = class extends SceneNode {
  #projection = identityMat4(new Float32Array(16));
  #view = identityMat4(new Float32Array(16));
  #viewProjection = identityMat4(new Float32Array(16));
  _projectionDirty = true;
  #viewWorldVersion = -1;
  #viewProjectionStale = true;
  get projection() {
    if (this._projectionDirty) {
      this._updateProjection(this.#projection);
      this._projectionDirty = false;
      this.#viewProjectionStale = true;
    }
    return this.#projection;
  }
  get view() {
    this.#syncView();
    return this.#view;
  }
  get viewProjection() {
    const projection = this.projection;
    this.#syncView();
    if (this.#viewProjectionStale) {
      multiplyMat4(this.#viewProjection, projection, this.#view);
      this.#viewProjectionStale = false;
    }
    return this.#viewProjection;
  }
  get viewProjectionMatrix() {
    return this.viewProjection;
  }
  #syncView() {
    const world = this.worldMatrix;
    if (this.#viewWorldVersion !== this._worldVersion) {
      invertAffineMat4(this.#view, world);
      this.#viewWorldVersion = this._worldVersion;
      this.#viewProjectionStale = true;
    }
  }
};
var PerspectiveCamera = class extends CameraNode {
  #fov;
  #aspect;
  #near;
  #far;
  constructor(options) {
    validateFov("perspectiveCamera", options.fov);
    if (options.aspect !== void 0)
      validateAspect("perspectiveCamera", options.aspect);
    validateRange3("perspectiveCamera", options.near ?? 0.1, options.far ?? 100);
    validateInitialLookAt("perspectiveCamera", options.target, options.up);
    super("perspective-camera", options);
    this.#fov = options.fov;
    this.#aspect = options.aspect;
    this.#near = options.near ?? 0.1;
    this.#far = options.far ?? 100;
    if (options.target)
      this.lookAt(options.target, options.up);
  }
  set(values) {
    super.set(values);
    const where = `${this.label ?? this.kind}.set`;
    if (values.fov !== void 0) {
      validateFov(where, values.fov);
      this.#fov = values.fov;
      this._projectionDirty = true;
    }
    if (values.aspect !== void 0) {
      validateAspect(where, values.aspect);
      this.#aspect = values.aspect;
      this._projectionDirty = true;
    }
    if (values.near !== void 0 || values.far !== void 0) {
      const near = values.near ?? this.#near;
      const far = values.far ?? this.#far;
      validateRange3(where, near, far);
      this.#near = near;
      this.#far = far;
      this._projectionDirty = true;
    }
    return this;
  }
  get fov() {
    return this.#fov;
  }
  /** Resolved aspect ratio; defaults to 1 until set explicitly. */
  get aspect() {
    return this.#aspect ?? 1;
  }
  get near() {
    return this.#near;
  }
  get far() {
    return this.#far;
  }
  _updateProjection(out) {
    out.set(perspective(degToRad(this.#fov), this.#aspect ?? 1, this.#near, this.#far));
  }
};
function perspectiveCamera(options) {
  return new PerspectiveCamera(options);
}
function validateInitialLookAt(where, target2, up) {
  if (target2 === void 0)
    return;
  if (target2.length !== 3)
    throw sceneValueError(where, "target", "an array of 3 numbers");
  if (up !== void 0 && up.length !== 3)
    throw sceneValueError(where, "up", "an array of 3 numbers");
}
function validateFov(where, fov) {
  if (!(fov > 0 && fov < 180))
    throw sceneValueError(where, "fov", "a field of view in degrees between 0 and 180 (exclusive)");
}
function validateRange3(where, near, far) {
  if (!(near > 0))
    throw sceneValueError(where, "near", "a positive near plane distance");
  if (!(far > near))
    throw sceneValueError(where, "far", "a far plane distance greater than `near`");
}
function validateAspect(where, aspect) {
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw sceneValueError(where, "aspect", "a positive, finite width/height ratio");
  }
}
export {
  box2 as box,
  clock,
  draw,
  effect,
  frame,
  frameLoop,
  geometry,
  init,
  perspectiveCamera,
  sampler,
  surface,
  target,
  texture
};
