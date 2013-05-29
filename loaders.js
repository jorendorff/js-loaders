// # loaders.js - ES6 module loaders illustrated
//
// This is a sample implementation of the ES6 module loader.  It implements the
// proposal in terms of ES6 plus a few primitives meant to be exposed by the
// implementation.
//
// Source code is on github:
// [jorendorff/js-loaders](https://github.com/jorendorff/js-loaders).
//
//
// ## References
//
//   * [ES6 Module Use Cases](https://gist.github.com/wycats/51c96e3adcdb3a68cbc3)
//     by Yehuda Katz
//
// You can join the conversation on the [es-discuss mailing
// list](https://mail.mozilla.org/listinfo/es-discuss), [in the github issue
// tracker](https://github.com/jorendorff/js-loaders/issues), or on IRC, in the
// `#jslang` channel on [irc.mozilla.org](https://wiki.mozilla.org/IRC).
//
//
// ## Current status
//
// This implementation of ES6 module loaders is incomplete and untested.  Some
// parts are in decent shape:
//
//   * the public `Loader` class;
//   * the `LoaderImpl` constructor;
//   * the methods for loading and running code:
//     `eval`, `evalAsync`, `load`, and `import`;
//   * the methods for directly accessing the module map:
//     `get`, `has`, `set`, and `delete`;
//   * the loader hooks and the loading pipeline that calls them;
//   * dependency loading;
//   * linking;
//   * execution order;
//   * error handling;
//   * the browser's configuration method, `ondemand`;
//   * the browser's custom loader hooks: `normalize`, `resolve`, and `fetch`.
//
// Some parts are not implemented at all yet:
//
//   * the last bit of plumbing connecting the load pipeline back to the success
//     and failure callbacks provided by load/evalAsync/import;
//   * support for custom link hooks that create dynamic-linked ("factory-made")
//     modules;
//   * intrinsics;
//   * probably various other odds and ends.

"use strict";

import { impl, newLoaderImpl } from "./impl";

// ## The Loader class
//
// The public API of the module loader system is the `Loader` class.
// A Loader is responsible for asynchronously finding, fetching, linking,
// and running modules and scripts.
//
export class Loader {
    // **`new Loader(parent, options)`** - Create a new `Loader`.
    constructor(parent, options) {
        // Since ES6 does not have support for private state or private
        // methods, everything private is stored on a separate `LoaderImpl`
        // object which is not accessible from user code.
        newLoaderImpl(this, parent, options);

        // P4 ISSUE: Detailed behavior of hooks.
        //
        // As implemented here, hooks are just ordinary properties of the
        // Loader object.  Default implementations are just ordinary methods
        // of the Loader class. Loader subclasses can add methods with the
        // appropriate names, and use `super()` to invoke the base-class
        // behavior, and stuff will "just work".
        //
        // It's not clear that's the right design.  What's specified in the
        // document right now is different: hooks are stored in internal
        // properties, and the loader exposes getters for each hook.  Firing
        // a hook takes it from the internal property.  In no circumstance
        // does `super` work.
        //
        let takeHook = name => {
            var hook = options[name];
            if (hook !== undefined) {
                $ObjectDefineProperty(this, name, {
                    configurable: true,
                    enumerable: true,
                    value: hook,
                    writable: true
                });
            }
        };

        takeHook("normalize");
        takeHook("resolve");
        takeHook("fetch");
        takeHook("translate");
        takeHook("link");
    }


    // ### Configuration

    // **`global`** - The global object associated with this loader.  All code
    // loaded by this loader runs in the scope of this object.
    get global() { return impl(this).global; }

    // **`strict`** - The loader's strictness setting.  If true, all code
    // loaded by this loader is treated as strict-mode code.
    get strict() { return impl(this).strict; }


    // ### Loading and running code
    //
    // The high-level interface of `Loader` consists of four methods for
    // loading and running code:

    // **`import`** - Asynchronously load a module and its dependencies.
    //
    // On success, pass the `Module` object to the success callback.
    //
    import(moduleName,
           callback = module => {},
           errback = exc => { throw exc; },
           options = undefined)
    {
        impl(this).import(moduleName, callback, errback, options);
    }

    // **`load`** - Asynchronously load and run a script.  If the script
    // contains import declarations, this can cause modules to be loaded.
    //
    // On success, pass the result of evaluating the script to the success
    // callback.
    //
    load(address,
         callback = value => {},
         errback = exc => { throw exc; },
         options = undefined)
    {
        impl(this).load(address, callback, errback, options);
    }

    // **`evalAsync`** - Asynchronously run some code, first loading any
    // imported modules that aren't already loaded.
    //
    // This is the same as `load` but with no need to fetch the initial script.
    // On success, the result of evaluating the program is passed to
    // the success callback.
    //
    evalAsync(src,
              callback = value => {},
              errback = exc => { throw exc; },
              options = undefined)
    {
        impl(this).evalAsync(src, callback, errback, options);
    }

    // **`eval`** - Synchronously run some code.
    //
    // `src` may import modules, but if it directly or indirectly imports a
    // module that is not already loaded, a `SyntaxError` is thrown.
    //
    // P2 ISSUE #8: Does global.eval go through the translate hook?
    //
    eval(src, options) {
        return impl(this).eval(src, options);
    }

    // **About `callback` and `errback`:** `Loader.prototype.evalAsync()`,
    // `.load()`, and `.import()` all take two callback arguments, `callback`
    // and `errback`, the success and failure callbacks respectively.
    //
    // On success, these methods each schedule the success callback to be
    // called with a single argument (the result of the operation).
    //
    // These three methods never throw. Instead, on error, the exception is
    // saved and passed to failure callback asynchronously.
    //
    // Both arguments are optional.  The default success callback does
    // nothing.  The default failure callback throws its argument.
    // *Rationale:*  The event loop will then treat it like any other
    // unhandled exception.
    //
    // Success and failure callbacks are always called in a fresh event
    // loop turn.  This means they will not be called until after
    // `evalAsync` returns, and they are always called directly from the
    // event loop:  except in the case of nested event loops, these
    // callbacks are never called while user code is on the stack.
    //
    // **Future directions:**  `evalAsync`, `import`, and `load` (as well as
    // the `fetch` loader hook, described later) all take callbacks and
    // currently return `undefined`.  They are designed to be
    // upwards-compatible to `Future`s.  per samth, 2013 April 22.
    //
    // P1 ISSUE #30: the callback and errback arguments should be last.


    // ### Module registry
    //
    // Each `Loader` has a **module registry**, a cache of already loaded and
    // linked modules.  The Loader uses this map to avoid fetching modules
    // multiple times.
    //
    // The methods below support directly querying and modifying the registry.
    // They are synchronous and never fire any loader hooks or trigger new
    // loads.

    // **`get`** - Get a module by name from the registry.  The argument `name`
    // is the full module name.
    //
    // Throw a TypeError if `name` is not a string.
    //
    // If the module is in the registry but has never been executed, first
    // synchronously execute the module and any dependencies that have not
    // executed yet.
    //
    get(name) {
        return impl(this).get(name);
    }

    // **`has`** - Return `true` if a module with the given full name is in the
    // registry.
    //
    // This doesn't call any hooks or execute any module code.
    //
    has(name) {
        return impl(this).has(name);
    }

    // **`set`** - Put a module into the registry.
    set(name, module) {
        impl(this).set(name, module);
        return this;
    }

    // **`delete`** - Remove a module from the registry.
    //
    // **`.delete()` and concurrent loads:** Calling `.delete()` has no
    // immediate effect on in-flight loads, but it can cause such a load to
    // fail later.
    //
    // That's because the dependency-loading algorithm (which we'll get to in a
    // bit) assumes that if it finds a module in the registry, it doesn't need
    // to load that module.  If someone deletes that module from the registry
    // (and doesn't replace it with something compatible), then when loading
    // finishes, it will find that a module it was counting on has vanished.
    // Linking will fail.
    //
    // **`.delete()` and already-linked code:** `loader.delete("A")` removes
    // only `A` from the registry, and not other modules linked against `A`,
    // for several reasons:
    //
    // 1. What a module is linked against is properly an implementation
    //    detail, which the "remove everything" behavior would leak.
    //
    // 2. The transitive closure of what is linked against what is
    //    an unpredictable amount of stuff, potentially a lot.
    //
    // 3. Some uses of modules&mdash;in particular polyfilling&mdash;involve
    //    defining a new module `MyX`, linking it against some busted built-in
    //    module `X`, then replacing `X` in the registry with `MyX`. So having
    //    multiple "versions" of a module linked together is a feature, not a
    //    bug.
    //
    delete(name) {
        impl(this).delete(name);
        return this;
    }


    // ### Loader hooks
    //
    // The import process can be customized by assigning to (or subclassing and
    // overriding) any number of the five loader hooks:
    //
    //   * `normalize(name, options)` - From a possibly relative module name,
    //     determine the full module name.
    //
    //   * `resolve(fullName, options)` - Given a full module name, determine
    //     the address to load and whether we're loading a script or a module.
    //
    //   * `fetch(address, fulfill, reject, skip, options)` - Load a script or
    //     module from the given address.
    //
    //   * `translate(src, options)` - Optionally translate a script or module from
    //     some other language to JS.
    //
    //   * `link(src, options)` - Determine dependencies of a module; optionally
    //     convert an AMD/npm/other module to an ES Module object.

    // **`normalize`** hook - For each `import()` call or import-declaration,
    // the Loader first calls `loader.normalize(name, options)` passing the
    // module name as passed to `import()` or as written in the
    // import-declaration.  This hook returns a full module name which is used
    // for the rest of the import process.  (In particular, modules are stored
    // in the registry under their full module name.)
    //
    // **When this hook is called:**  For all imports, including imports in
    // scripts.  It is not called for the main script body executed by a call
    // to loader.load(), .eval(), or .evalAsync().
    //
    // After calling this hook, if the full module name is in the registry,
    // loading stops. Otherwise loading continues, calling the `resolve`
    // hook.
    //
    // The `normalize` hook may also create a custom "metadata" value that will
    // be passed automatically to the other hooks in the pipeline.
    //
    // Returns either:
    //
    //   - a string, the full module name.  The loader will create a new empty
    //     Object to serve as the metadata object for the rest of the load. Or:
    //
    //   - an object that has a `.normalized` property that is a string, the
    //     full module name.
    //
    // **Default behavior:**  Return the module name unchanged.
    //
    normalize(name, options) {
        return name;
    }

    // **`resolve`** hook - Given a full module name, determine the resource
    // address (URL, path, etc.) to load.
    //
    // The `resolve` hook is also responsible for determining whether the
    // resource in question is a module or a script.
    //
    // The hook may return:
    //
    //   - a string, the resource address. In this case the resource is a
    //     module.
    //
    //   - an object that has a `.address` property which is a string, the
    //     resource address.  The object may also have a `.extra` property,
    //     which if present must be an iterable of strings, the names of the
    //     modules defined in the script at the given address.
    //
    // **When this hook is called:**  For all imports, immediately after the
    // `normalize` hook returns successfully, unless the module is already
    // loaded or loading.
    //
    // **Default behavior:**  Return the module name unchanged.
    //
    // (The browser's System.resolve hook is considerably more complex.)
    //
    resolve(normalized, options) {
        return normalized;
    }

    // **`fetch`** hook - Asynchronously fetch the requested source from the
    // given address (produced by the `resolve` hook).
    //
    // This is the hook that must be overloaded in order to make the `import`
    // keyword work.
    //
    // The `fetch` hook should load the requested address and call the
    // `fulfill` callback, passing two arguments: the fetched source, as a
    // string; and the actual address where it was found (after all redirects),
    // also as a string.
    //
    // `options.type` is the string `"module"` when fetching a standalone
    // module, and `"script"` when fetching a script.
    //
    // **When this hook is called:** For all modules and scripts whose source
    // is not directly provided by the caller.  It is not called for the script
    // bodies executed by `loader.eval()` and `.evalAsync()`, since those do
    // not need to be fetched.  `loader.evalAsync()` can trigger this hook, for
    // modules imported by the script.  `loader.eval()` is synchronous and thus
    // never triggers the `fetch` hook.
    //
    // (`loader.load()` does not call `normalize`, `resolve`, or `link`, since
    // we're loading a script, not a module; but it does call the `fetch` and
    // `translate` hooks, per samth, 2013 April 22.)
    //
    // **Synchronous calls to `fulfill` and `reject`:** (P2 ISSUE #9) The
    // `fetch` hook may call the `fulfill` or `reject` callback synchronously
    // rather than waiting for the next event loop turn.  But in that case
    // `fulfill` simply schedules the pipeline to resume asynchronously.  Per
    // meeting, 2013 April 26. *Rationale:* It would be strange for a
    // synchronous `fulfill` callback to synchronously call `translate`/`link`
    // hooks before the `fetch` hook has returned. To say nothing of
    // `normalize`/`resolve`/`fetch` hooks for dependencies.
    //
    // **Default behavior:** Pass a `TypeError` to the `reject` callback.
    //
    fetch(resolved, fulfill, reject, options) {
        AsyncCall(() => reject($TypeError("Loader.prototype.fetch was called")));
    }

    // **`translate`** hook - Optionally translate `src` from some other
    // language into JS.
    //
    // **When this hook is called:**  For all modules and scripts.  (It is
    // not decided whether this is called for direct eval scripts; see issue on
    // Loader.eval().)
    //
    // **Default behavior:** Return `src` unchanged.
    //
    translate(src, options) {
        return src;
    }

    // **`link`** hook - Allow a loader to optionally override the default
    // linking behavior.  There are three options.
    //
    //  1. The link hook may return `undefined`. The loader then uses the
    //     default linking behavior.  It parses src as a script or module body,
    //     looks at its imports, loads all dependencies asynchronously, and
    //     finally links them as a unit and adds them to the registry.
    //
    //     The module bodies will then be executed on demand; see
    //     ensureExecuted.
    //
    //  2. The hook may return a full `Module` instance object.  The loader then
    //     simply adds that module to the registry.
    //
    //     P3 ISSUE #17: Timing in this case.
    //
    //     P3 ISSUE #18: link hook returning a Module vs. loader.set().
    //
    //  3. *(unimplemented)* The hook may return a factory object which the
    //     loader will use to create the module and link it with its clients
    //     and dependencies.
    //
    //     The form of a factory object is:
    //
    //         {
    //             imports: <array of strings (module names)>,
    //             ?exports: <array of strings (property names)>,
    //             execute: <function (Module, Module, ...) -> Module>
    //         }
    //
    //     The array of exports is optional.  If the hook does not specify
    //     exports, the module is dynamically linked.  In this case, it is
    //     executed during the linking process.  First all of its
    //     dependencies are executed and linked, and then passed to the
    //     relevant execute function.  Then the resulting module is linked
    //     with the downstream dependencies.  This requires incremental
    //     linking when such modules are present, but it ensures that
    //     modules implemented with standard source-level module
    //     declarations can still be statically validated.
    //
    //     P3 ISSUE #19: how does this work?
    //
    // **When this hook is called:**  After the `translate` hook, for modules
    // only.
    //
    // **Default behavior:**  Return undefined.
    //
    link(src, options) {
    }

    // ### Globals, builtins, and intrinsics

    // Define all the built-in objects and functions of the ES6 standard
    // library associated with this loader's intrinsics as properties on
    // `obj`.
    defineBuiltins(obj = impl(this).global) {
        $DefineBuiltins(obj, this);
        return obj;
    }
}

export var System = new Loader;
