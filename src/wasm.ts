// @ts-expect-error -- no types
import baselineModuleBuffer from "../build/wasm/llhttp_baseline.js";
// @ts-expect-error -- no types
import optModuleBuffer from "../build/wasm/llhttp_opt.js";
import { constants } from "./llhttp";

export const ERROR = constants.ERROR;

interface Imports {
  env: {
    wasm_on_message_begin: (parser: number) => number;
    wasm_on_url: (parser: number, at: number, length: number) => number;
    wasm_on_status: (parser: number, at: number, length: number) => number;
    wasm_on_header_field: (
      parser: number,
      at: number,
      length: number,
    ) => number;
    wasm_on_header_value: (
      parser: number,
      at: number,
      length: number,
    ) => number;
    wasm_on_headers_complete: (
      parser: number,
      status_code: number,
      upgrade: number,
      should_keep_alive: number,
    ) => number;
    wasm_on_body: (parser: number, at: number, length: number) => number;
    wasm_on_message_complete: (parser: number) => number;
  };
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  llhttp_alloc(type: number): number;
  malloc(size: number): number;
  free(ptr: number): void;
  llhttp_get_type(parser: number): number;
  llhttp_get_http_major(parser: number): number;
  llhttp_get_http_minor(parser: number): number;
  llhttp_get_method(parser: number): number;
  llhttp_get_status_code(parser: number): number;
  llhttp_get_upgrade(parser: number): number;
  llhttp_reset(parser: number): void;
  llhttp_execute(parser: number, data: number, len: number): number;
  llhttp_finish(parser: number): number;
  llhttp_pause(parser: number): void;
  llhttp_resume(parser: number): void;
  llhttp_resume_after_upgrade(parser: number): void;
  llhttp_get_errno(parser: number): number;
  llhttp_get_error_reason(parser: number): number;
  llhttp_set_error_reason(parser: number, reason: number): void;
  llhttp_get_error_pos(parser: number): number;
  llhttp_errno_name(errno: number): number;
  llhttp_method_name(method: number): number;
  llhttp_status_name(status: number): number;
  llhttp_set_lenient_headers(parser: number, enabled: number): void;
  llhttp_set_lenient_chunked_length(parser: number, enabled: number): void;
  llhttp_set_lenient_keep_alive(parser: number, enabled: number): void;
  llhttp_set_lenient_transfer_encoding(parser: number, enabled: number): void;
  llhttp_set_lenient_version(parser: number, enabled: number): void;
  llhttp_set_lenient_data_after_close(parser: number, enabled: number): void;
  llhttp_set_lenient_optional_lf_after_cr(
    parser: number,
    enabled: number,
  ): void;
  llhttp_set_lenient_optional_crlf_after_chunk(
    parser: number,
    enabled: number,
  ): void;
  llhttp_set_lenient_optional_cr_before_lf(
    parser: number,
    enabled: number,
  ): void;
  llhttp_set_lenient_spaces_after_chunk_size(
    parser: number,
    enabled: number,
  ): void;
  llhttp_message_needs_eof(parser: number): number;
}

const REVERSE_METHODS = Object.fromEntries(
  Object.entries(constants.METHODS).map(([ k, v ]) => [ v, k ]),
);

let instance: WebAssembly.Instance | null = null;
const parsers = new Map<number, Parser>();

const DISPOSE: typeof Symbol.dispose = Symbol.dispose ??
  Symbol.for("Symbol.dispose");

export interface Callbacks {
  onHeadersComplete: (
    versionMajor: number,
    versionMinor: number,
    headers: [string, string][],
    method: string,
    url: string,
    statusCode: number,
    statusText: string,
    upgrade: boolean,
    shouldKeepAlive: boolean,
  ) => void;
  onBody: (body: Uint8Array) => void;
  onFinish: (trailers: [string, string][] | null) => void;
}

export class Parser implements Disposable {
  static #instancePromise = (async () => {
    const imports: Imports = {
      env: {
        wasm_on_message_begin(parser) {
          void parser;
          return 0;
        },
        wasm_on_url(parser, at, length) {
          const p = parsers.get(parser)!;
          p.#url = p.#str(at, length);
          return 0;
        },
        wasm_on_status(parser, at, length) {
          const p = parsers.get(parser)!;
          p.#statusMessage = p.#str(at, length);
          return 0;
        },
        wasm_on_header_field(parser, at, length) {
          const p = parsers.get(parser)!;
          p.#headerField = p.#str(at, length);
          return 0;
        },
        wasm_on_header_value(parser, at, length) {
          const p = parsers.get(parser)!;
          p.#headers ??= [];
          p.#headers.push([ p.#headerField, p.#str(at, length) ]);
          return 0;
        },
        wasm_on_headers_complete(
          parser,
          status_code,
          upgrade,
          should_keep_alive,
        ) {
          const p = parsers.get(parser)!;
          p.#cb.onHeadersComplete(
            p.#exports.llhttp_get_http_major(parser),
            p.#exports.llhttp_get_http_minor(parser),
            p.#headers!,
            p.#exports.llhttp_get_type(parser) === constants.TYPE.REQUEST ?
              REVERSE_METHODS[p.#exports.llhttp_get_method(parser)] :
              "",
            p.#url,
            status_code,
            p.#statusMessage,
            upgrade !== 0,
            should_keep_alive !== 0,
          );
          p.#headers = null;
          return 0;
        },
        wasm_on_body(parser, at, length) {
          const p = parsers.get(parser)!;
          p.#cb.onBody(p.#mem.subarray(at, at + length));
          return 0;
        },
        wasm_on_message_complete(parser) {
          const p = parsers.get(parser)!;
          p.#cb.onFinish(p.#headers);
          return 0;
        },
      },
    };

    try {
      ({ instance } = await WebAssembly.instantiate(
        optModuleBuffer,
        imports as unknown as WebAssembly.Imports,
      ));
    } catch {
      ({ instance } = await WebAssembly.instantiate(
        baselineModuleBuffer,
        imports as unknown as WebAssembly.Imports,
      ));
    }

    const exports = instance.exports as unknown as Exports;
    exports._initialize(); // wasi reactor

    return instance;
  })().catch();

  #exports: Exports;
  #parser: number;
  #mem: Uint8Array;

  #url = "";
  #statusMessage = "";
  #headerField = "";
  #headers: [string, string][] | null = [];

  #cb: Callbacks;

  static request(cb: Callbacks): Parser | Promise<Parser> {
    if (instance === null) {
      return Parser.#instancePromise.then(
        (instance) => new Parser(cb, instance, constants.TYPE.REQUEST),
      );
    }
    return new Parser(cb, instance, constants.TYPE.REQUEST);
  }

  static response(cb: Callbacks): Parser | Promise<Parser> {
    if (instance === null) {
      return Parser.#instancePromise.then(
        (instance) => new Parser(cb, instance, constants.TYPE.RESPONSE),
      );
    }
    return new Parser(cb, instance, constants.TYPE.RESPONSE);
  }

  private constructor(
    cb: Callbacks,
    instance: WebAssembly.Instance,
    type: number,
  ) {
    this.#cb = cb;
    this.#exports = instance.exports as unknown as Exports;
    this.#parser = this.#exports.llhttp_alloc(type);
    parsers.set(this.#parser, this);
    this.#mem = new Uint8Array(this.#exports.memory.buffer);
  }

  destroy() {
    parsers.delete(this.#parser);
    this.#exports.free(this.#parser);
  }

  reset() {
    this.#exports.llhttp_reset(this.#parser);
    this.#url = "";
    this.#statusMessage = "";
    this.#headerField = "";
    this.#headers = [];
  }

  [DISPOSE]() {
    this.destroy();
  }

  #str(ptr: number, len: number): string {
    return new TextDecoder().decode(this.#mem.subarray(ptr, ptr + len));
  }

  #checkError(ret: number) {
    if (ret === constants.ERROR.OK) return;
    console.log(ret);
    const ptr = this.#exports.llhttp_get_error_reason(this.#parser);
    const len = this.#mem.indexOf(0, ptr) - ptr;
    throw new Error(this.#str(ptr, len));
  }

  execute(data: Uint8Array) {
    const ptr = this.#exports.malloc(data.byteLength);
    this.#mem.set(data, ptr);
    let err = this.#exports.llhttp_execute(this.#parser, ptr, data.length);
    this.#exports.free(ptr);

    if (err == constants.ERROR.PAUSED_UPGRADE) {
      err = constants.ERROR.OK;
      this.#exports.llhttp_resume_after_upgrade(this.#parser);
    }

    this.#checkError(err);
    return err;
  }

  finish() {
    this.#checkError(this.#exports.llhttp_finish(this.#parser));
  }

  pause() {
    this.#exports.llhttp_pause(this.#parser);
  }

  resume() {
    this.#exports.llhttp_resume(this.#parser);
  }

  setLenient(
    flag:
      | "headers"
      | "chunkData"
      | "keepAlive"
      | "transferEncoding"
      | "version"
      | "dataAfterClose"
      | "optionalLFAfterCR"
      | "optionalCRLFAfterChunk"
      | "optionalCRBeforeLF"
      | "spacesAfterChunkSize",
    enabled: boolean,
  ) {
    const n = enabled ? 1 : 0;
    switch (flag) {
      case "headers":
        this.#exports.llhttp_set_lenient_headers(this.#parser, n);
        break;
      case "chunkData":
        this.#exports.llhttp_set_lenient_chunked_length(this.#parser, n);
        break;
      case "keepAlive":
        this.#exports.llhttp_set_lenient_keep_alive(this.#parser, n);
        break;
      case "transferEncoding":
        this.#exports.llhttp_set_lenient_transfer_encoding(this.#parser, n);
        break;
      case "version":
        this.#exports.llhttp_set_lenient_version(this.#parser, n);
        break;
      case "dataAfterClose":
        this.#exports.llhttp_set_lenient_data_after_close(this.#parser, n);
        break;
      case "optionalLFAfterCR":
        this.#exports.llhttp_set_lenient_optional_lf_after_cr(this.#parser, n);
        break;
      case "optionalCRLFAfterChunk":
        this.#exports.llhttp_set_lenient_optional_crlf_after_chunk(
          this.#parser,
          n,
        );
        break;
      case "optionalCRBeforeLF":
        this.#exports.llhttp_set_lenient_optional_cr_before_lf(this.#parser, n);
        break;
      case "spacesAfterChunkSize":
        this.#exports.llhttp_set_lenient_spaces_after_chunk_size(
          this.#parser,
          n,
        );
        break;
    }
  }
}

if (require.main === module) {
  (async () => {
    const cb: Callbacks = {
      onHeadersComplete(
        versionMajor,
        versionMinor,
        rawHeaders,
        method,
        url,
        statusCode,
        statusText,
        upgrade,
        shouldKeepAlive,
      ) {
        console.log({
          versionMajor,
          versionMinor,
          rawHeaders,
          method,
          url,
          statusCode,
          statusText,
          upgrade,
          shouldKeepAlive,
        });
      },
      onBody(body) {
        console.log(body);
      },
      onFinish() {
        console.log("done");
      },
    };

    {
      using p = await Parser.request(cb);
      p.execute(
        Buffer.from(
          [
            "POST /owo HTTP/1.1",
            "X: Y",
            "Content-Length: 9",
            "",
            "uh, meow?",
            "",
          ].join("\r\n"),
        ),
      );
      p.finish();
    }

    {
      using p = await Parser.response(cb);
      p.execute(
        Buffer.from(
          [ "HTTP/1.1 200 OK", "X: Y", "Content-Length: 9", "", "uh, meow?" ]
            .join(
              "\r\n",
            ),
        ),
      );
      p.finish();
    }
  })();
}
