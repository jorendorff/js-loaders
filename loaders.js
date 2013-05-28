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
//   * the `Loader` constructor;
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


// ## Primitives

// We rely on the JavaScript implementation to provide a few primitives.  You
// can skip over this stuff. On the other hand, it tells what sort of thing
// we'll be doing here.
import {
    // * `$Assert(condition)` is your bog-standard assert function. It does
    //   nothing. The given `condition` is always true.
    $Assert,

    // * `$QueueTask(fn)` schedules a callback `fn` to be called in a later
    //   event loop turn.  Much like `setTimeout(fn, 0)`.  The HTML spec calls
    //   this "[queueing a
    //   task](http://www.whatwg.org/specs/web-apps/current-work/multipage/webappapis.html#queue-a-task)".
    //   Here, it&rsquo;s mainly used to ensure that user callbacks are called
    //   from an empty stack.
    $QueueTask,

    // * `$DefineBuiltins(obj)` builds a full copy of the ES builtins on `obj`,
    //   so for example you get a fresh new `obj.Array` constructor and methods
    //   like `obj.Array.prototype.push`. You even get `obj.Loader`, a copy of
    //   `Loader`.
    $DefineBuiltins,

    // Now on to the core JS language implementation intrinsics.

    // * `$Parse(loader, src, moduleName, address, strict)` parses a script or
    //   module body. If `moduleName` is null, then `src` is parsed as an ES6
    //   Program; otherwise `moduleName` is a string, and `src` is parsed as a
    //   module body.  `$Parse` detects ES "early errors" and throws
    //   `SyntaxError`.  On success, it returns a script object.  This is the
    //   only way script objects are created.  (Script objects are never exposed
    //   to user code; they are for use with the following intrinsics only.)
    //
    //   Note that this does not execute any of the code in `src`.
    //
    $Parse,

    // * `$ScriptDeclaredModuleNames(script)` returns an array of strings, the
    //   names of all modules declared in the script.
    //
    //   A script declares modules using this syntax: `module "vc" {
    //   ... }`.  Modules don't nest, and they can only occur at toplevel, so
    //   there is a single flat array for the whole script.
    //
    $ScriptDeclaredModuleNames,

    // * `$ScriptGetDeclaredModule(script, name)` returns a `Module` object for
    //   a module declared in the body of the given `script`.
    //
    //   Modules declared in scripts must be linked and executed before they
    //   are exposed to user code.
    //
    $ScriptGetDeclaredModule,

    // * `$ScriptImports(script)` returns an array of pairs representing every
    //   import-declaration in `script`. See the comment in `Loader.eval()`.
    $ScriptImports,

    // * `$LinkScript(script, modules)` links a script to all the modules
    //   requested in its imports. `modules` is an array of `Module` objects,
    //   the same length as `$ScriptImports(script)`.
    //
    //   Throws if any `import`-`from` declaration in `script` imports a name
    //   that the corresponding module does not export.
    //
    $LinkScript,

    // * `$ModuleGetDeclaringScript(module)` returns a script object. If
    //   `$ScriptGetDeclaredModule(script, name) === module` for some string
    //   `name`, then `$ModuleGetDeclaringScript(module) === script`.
    $ModuleGetDeclaringScript,

    // The two remaining primitives operate on both scripts and modules.

    // * `$CodeExecute(c)` executes the body of a script or module. If `c` is a
    //   module, return undefined. If it's a script, return the value of the
    //   last-executed expression statement (just like `eval`).
    $CodeExecute,

    // * `$CodeGetLinkedModules(c)` returns an array of the modules linked to
    //   `c` in a previous `$LinkScript` call.  (We could perhaps do without
    //   this by caching this information in a WeakMap.)
    $CodeGetLinkedModules
} from "implementation-intrinsics";

// TODO: Consider removing `$ScriptImports` in favor of a `$CodeImports` that
// we call separately on modules and scripts; `$LinkScript` would become
// `$CodeLink` and then `$CodeGetLinkedModules` could really be replaced with a
// `WeakMap`.

// The remaining primitives are not very interesting. These are capabilities
// that JS provides via builtin methods. We use primitives rather than the
// builtin methods because user code can delete or replace the methods.
import {
    $ToString,      // $ToString(v) === ES ToString algorithm ~= ("" + v)
    $Apply,         // $Apply(f, thisv, args) ~= thisv.apply(f, args)
    $Call,          // $Call(f, thisv, ...args) ~= thisv.call(f, ...args)
    $ObjectDefineProperty, // $ObjectDefineProperty(obj, p, desc) ~= Object.defineProperty(obj, p, desc)
    $IsArray,       // $IsArray(v) ~= Array.isArray(v)
    $ArrayPush,     // $ArrayPush(arr, v) ~= arr.push(v)
    $ArrayPop,      // $ArrayPop(arr) ~= arr.pop()
    $SetNew,        // $SetNew() ~= new Set
    $SetHas,        // $SetHas(set, v) ~= set.has(v)
    $SetAdd,        // $SetAdd(set, v) ~= set.add(v)
    $MapNew,        // $MapNew() ~= new Map
    $MapHas,        // $MapHas(map, key) ~= map.has(key)
    $MapGet,        // $MapGet(map, key) ~= map.get(key)
    $MapSet,        // $MapSet(map, key, value) ~= map.set(key, value)
    $MapDelete,     // $MapDelete(map, key) ~= map.delete(key)
    $TypeError,     // $TypeError(msg) ~= new TypeError(msg)
    $SyntaxError    // $SyntaxError(msg) ~= new SyntaxError(msg)
} from "implementation-builtins";


// ## The Loader class
//
// A Loader is responsible for asynchronously finding, fetching, linking,
// and running modules and scripts.
//
export class Loader {
    // Create a new Loader.
    //
    // P3 ISSUE #10: Is the parent argument necessary?
    //
    constructor(parent, options) {
        // **`this.@modules`** is the module registry.  It maps full module
        // names to `Module` objects.
        //
        // This map only ever contains `Module` objects that have been fully
        // linked.  However it can contain modules whose bodies have not yet
        // started to execute.  Except in the case of cyclic imports, such
        // modules are not exposed to user code.  See `ensureExecuted()`.
        //
        // **Notation.** This weird `loader.@modules` syntax is not part of the
        // JS language. It is only meant to indicate that the `@modules`
        // property is private.  TODO: Instead, implement private state with a
        // `WeakMap`.
        //
        this.@modules = $MapNew();

        // **`this.@loads`** stores information about modules that are loading
        // or loaded but not yet linked.  It maps full module names to `Load`
        // objects.
        //
        // This is stored in the loader so that multiple calls to
        // `loader.load()/.import()/.evalAsync()` can cooperate to fetch what
        // they need only once.
        //
        this.@loads = $MapNew();

        // Various configurable options.
        this.@global = options.global;  // P4 ISSUE: ToObject here?
        this.@strict = ToBoolean(options.strict);

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


    // ## Configuration

    // **`global`** - The global object associated with this loader.  All code
    // loaded by this loader runs in the scope of this object.
    get global() {
        return this.@global;
    }

    // **`strict`** - The loader's strictness setting.  If true, all code
    // loaded by this loader is treated as strict-mode code.
    get strict() {
        return this.@strict;
    }


    // ## Loading and running code
    //
    // The major methods of `Loader` are for loading and running code:
    //
    //   * `eval(src, options)` - Synchronously run some code.  Never loads
    //     modules, but `src` may import already-loaded modules.
    //
    //   * `import(moduleName, callback, errback)` - Asynchronously load a
    //     module and its dependencies.
    //
    //   * `evalAsync(src, callback, errback, options)` - Asynchronously run
    //     some code.  Loads imported modules.
    //
    //   * `load(address, callback, errback, options)` - Asynchronously load
    //     and run a script.  Loads imported modules.

    // P1 ISSUE #30: the callback and errback arguments should be last.

    // **`eval`** - Evaluate the program `src`.
    //
    // `src` may import modules, but if it imports a module that is not
    // already loaded, a `SyntaxError` is thrown.
    //
    // P2 ISSUE #8: Does global.eval go through the translate hook?
    //
    eval(src, options) {
        let address = Loader.@unpackAddressOption(options, null);

        // The loader works in three basic phases: load, link, and execute.
        // During the **load phase**, code is loaded and parsed, and import
        // dependencies are traversed.

        // The `Load` object here is *pro forma*; `eval` is synchronous and
        // thus cannot fetch code.
        let load = new Load([]);
        let linkSet = new LinkSet(this, load, null, null);

        // Finish loading `src`.  This is the part where, in an *asynchronous*
        // load, we would trigger further loads for any imported modules that
        // are not yet loaded.
        //
        // Instead, here we pass `true` to `@onFulfill` to indicate that we're
        // doing a synchronous load.  This makes it throw rather than trigger
        // any new loads or add any still-loading modules to the link set.  If
        // this doesn't throw, then we have everything we need and load phase
        // is done.
        //
        this.@onFulfill(load, {}, null, "script", true, src, address);

        // The **link phase** links each imported name to the corresponding
        // module or export.
        linkSet.link();

        // During the **execute phase**, we first execute module bodies for any
        // modules needed by `script` that haven't already executed.  Then we
        // evaluate `script` and return that value.
        return ensureExecuted(script);
    }

    // **`evalAsync`** - Asynchronously evaluate the program `src`.
    //
    // `src` may import modules that have not been loaded yet.  In that case,
    // load all those modules, and their imports, transitively, before
    // evaluating the script.
    //
    // On success, the result of evaluating the program is passed to
    // `callback`.
    //
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
    // **Future directions:**  `evalAsync`, `import`, `load`, and the `fetch`
    // hook all take callbacks and currently return `undefined`.  They are
    // designed to be upwards-compatible to `Future`s.  per samth, 2013 April 22.
    //
    evalAsync(src,
              callback = value => undefined,
              errback = exc => { throw exc; },
              options = undefined)
    {
        // P4 ISSUE: Check callability of callbacks here (and everywhere
        // success/failure callbacks are provided)?  It would be a mercy,
        // since the TypeError if they are not functions happens much later
        // and with an empty stack.  But Futures don't do it.  Assuming no.
        //
        //     if (typeof callback !== "function")
        //         throw $TypeError("Loader.load: callback must be a function");
        //     if (typeof errback !== "function")
        //         throw $TypeError("Loader.load: error callback must be a function");
        //
        let address = Loader.@unpackAddressOption(options, errback);
        if (address === undefined)
            return;

        let load = new Load([]);
        let run = Loader.@makeEvalCallback(load, callback, errback);
        new LinkSet(this, load, run, errback);
        this.@onFulfill(load, {}, null, "script", false, src, address);
    }

    // **`load`** - Asynchronously load and run a script.  If the script
    // contains import declarations, this can cause modules to be loaded,
    // linked, and executed.
    //
    // On success, the result of evaluating the script is passed to the success
    // callback.
    //
    load(address,
         callback = value => undefined,
         errback = exc => { throw exc; },
         options = undefined)
    {
        // Build a referer object.
        let refererAddress = Loader.@unpackAddressOption(options, errback);
        if (refererAddress === undefined)
            return;
        let referer = {name: null, address: refererAddress};

        // Create an empty metadata object.  *Rationale:*  The `normalize` hook
        // only makes sense for modules; `load()` loads scripts.  But we do
        // want `load()` to use the `fetch` hook, which means we must come up
        // with a metadata value of some kind (this is ordinarily the
        // `normalize` hook's responsibility).
        //
        // `metadata` is created using the intrinsics of the enclosing loader
        // class, not the Loader's intrinsics.  *Rationale:*  It is for the
        // loader hooks to use.  It is never exposed to code loaded by this
        // Loader.
        //
        let metadata = {};

        let load = new Load([]);
        let run = Loader.@makeEvalCallback(load, callback, errback);
        new LinkSet(this, load, run, errback);
        return this.@callFetch(load, address, referer, metadata, null, "script");
    }

    // **`import`** - Asynchronously load, link, and execute a module and any
    // dependencies it imports.  On success, pass the `Module` object to the
    // success callback.
    //
    // The comment on `evalAsync()` explains `callback` and `errback`.
    //
    import(moduleName,
           callback = () => undefined,
           errback = exc => { throw exc; },
           options = undefined)
    {
        // Build referer.
        let name = null;
        if (options !== undefined && "module" in options) {
            name = options.module;
            if (typeof name !== "string") {
                AsyncCall(errback, $TypeError("import: options.module must be a string"));
                return;
            }
        }
        let address = Loader.@unpackAddressOption(options, errback);
        if (address === undefined)
            return;
        let referer = {name, address};

        // this.@import starts us along the pipeline.
        let fullName;
        try {
            fullName = this.@import(referer, moduleName, false);
        } catch (exc) {
            AsyncCall(errback, exc);
            return;
        }

        let m = $MapGet(this.@modules, fullName);
        if (m !== undefined) {
            // We already had this module in the registry.
            AsyncCall(success, m);
        } else {
            // TODO - BUG - if @import failed, the load will have removed
            // itself from this.@loads.

            // The module is now loading.  When it loads, it may have more
            // imports, requiring further loads, so put it in a LinkSet.
            let load = $MapGet(this.@loads, fullName);

            // We will look the module up again. Since callbacks are async,
            // something may have happened to it. TODO: pull it out of
            // load.script instead.
            let callback = () => success($MapGet(this.@modules, fullName));

            new LinkSet(this, load, callback, errback);
        }

        function success(m) {
            try {
                if (m === undefined) {
                    throw $TypeError("import(): module \"" + fullName +
                                     "\" was deleted from the loader");
                }
                ensureExecuted(m);
            } catch (exc) {
                return errback(exc);
            }
            return callback(m);
        }
    }

    // **`@unpackAddressOption`** - Used by several Loader methods to get
    // `options.address` and check that if present, it is a string.
    //
    // `eval()`, `evalAsync()`, and `load()` all accept an optional `options`
    // object. `options.address`, if present, is passed to each loader hook,
    // for each module loaded, as `options.referer.address`.  (The default
    // loader hooks ignore it, though.)
    //
    // (`options.address` may also be stored in the script and used for
    // `Error().fileName`, `Error().stack`, and developer tools; but such use
    // is outside the scope of the language standard.)
    //
    // P5 SECURITY ISSUE: Make sure that is OK.
    //
    // P2 ISSUE #31: Consider `options.module`.
    //
    // P2 ISSUE #32:  Consider `options.lineNumber`.
    //
    static @unpackAddressOption(options, errback) {
        if (options !== undefined && "address" in options) {
            let address = options.address;
            if (typeof address !== "string") {
                let exc = $TypeError("options.address must be a string, if present");

                // `errback` is null when the caller is synchronous `eval()`.
                // In that case, just throw.
                if (errback === null)
                    throw exc;

                // Otherwise, report the error asynchronously.  The caller must
                // check for `undefined`.
                AsyncCall(errback, exc);
                return undefined;
            }
            return address;
        }

        // The default address is null, per samth 2013 May 24.
        return null;
    }

    // **`@makeEvalCallback`** - Create and return a callback, to be called
    // after linking is complete, that executes the script loaded by the given
    // `load`.
    static @makeEvalCallback(load, callback, errback) {
        return () => {
            // Tail calls would be equivalent to AsyncCall, except for
            // possibly some imponderable timing details.  This is meant as
            // a reference implementation, so we just literal-mindedly do
            // what the spec is expected to say.
            let result;
            try {
                result = ensureExecuted(load.script);
            } catch (exc) {
                AsyncCall(errback, exc);
                return;
            }
            AsyncCall(callback, result);
        };
    }


    // ## The loader pipeline

    // **`@import`** - The common implementation of the `import()` method and the
    // processing of `import` declarations in ES code.
    //
    // There are several possible outcomes:
    //
    // 1.  Getting `this.normalize` throws, or the `normalize` hook isn't
    //     callable, or it throws an exception, or it returns an invalid value.
    //     In these cases, `@import` throws.
    //
    // 2.  The `normalize` hook returns the name of a module that is already in
    //     the registry.  `@import` returns the normalized name.
    //
    // 3.  This is a synchronous import (for `eval()`) and the module is not
    //     yet loaded.  `@import` throws.
    //
    // 4.  In all other cases, either a new `Load` is started or we can join
    //     one already in flight.  `@import` returns the normalized name.
    //
    // `referer` provides information about the context of the `import()` call
    // or import-declaration.  This information is passed to all the loader
    // hooks.
    //
    // `name` is the (pre-normalize) name of the module to be imported, as it
    // appears in the import-declaration or as the argument to
    // loader.import().
    //
    // TODO:  Suggest alternative name for `referer`.  It is really nothing to
    // do with the nasty Referer HTTP header.  Perhaps `importContext`,
    // `importer`, `client`.
    //
    @import(referer, name, sync) {
        // Call the `normalize` hook to get a normalized module name and
        // metadata.  See the comment on `normalize()`.
        //
        // Errors that happen during this step propagate to the caller.
        //
        let normalized, metadata;
        {
            // P4 ISSUE: Here `referer` is passed to the `normalize` hook and
            // later it is passed to the `resolve` hook, and so on.  Should we
            // create a new object each time?  (I think it's OK to pass the
            // same referer object to successive hooks within a single load;
            // but `eval()` creates a new referer object for each call to the
            // `normalize()` hook, since they are not abstractly all part of a
            // single load.)
            let result = this.normalize(request, {referer});

            // Interpret the `result`.
            //
            // It must a string or an object with a `.normalized` property
            // whose value is a string.  Otherwise a `TypeError` is thrown.
            // per samth, 2013 April 22, and issue #13.
            //
            if (typeof result === "string") {
                normalized = result;
                metadata = {};
            } else if (!IsObject(result)) {
                // The result is `null`, a boolean, a number, or (if symbols
                // somehow get defined as primitives) a symbol. Throw.
                //
                // *Rationale:*  Both a string and an object are possibly valid
                // return values.  We could use `ToString` or `ToObject` to
                // coerce this value.  But neither is the slightest bit
                // compelling or useful.  So throw instead.
                //
                throw $TypeError(
                    "Loader.normalize hook must return undefined, " +
                    "a string, or an object");
            } else {
                // Several hooks, including the `normalize` hook, may return
                // multiple values, by returning an object where several
                // properties are significant.  In all these cases, the object
                // is just a temporary record.  The loader immediately gets the
                // data it wants out of the returned object and then discards
                // it.
                //
                // In this case, we care about two properties on the returned
                // object, `.normalized` and `.metadata`, but only
                // `.normalized` is required.
                //
                if (!("normalized" in result)) {
                    throw $TypeError(
                        "Result of loader.normalize hook must be undefined, a string, or " +
                        "an object with a .normalized property");
                }

                normalized = result.normalized;  // can throw

                // Do not use `$ToString` here, per samth, 2013 April 22.
                if (typeof normalized !== "string") {
                    throw $TypeError(
                        "Object returned by loader.normalize hook must have " +
                        "a string .normalized property");
                }

                metadata = result.metadata;  // can throw
            }
        }

        // If the module has already been linked, we are done.
        // P3 ISSUE #12:  Loader hooks can't always detect pipeline exit.
        if ($MapHas(this.@modules, normalized))
            return normalized;

        // If the module is already loaded, we are done.
        let load = $MapGet(this.@loads, normalized);
        if (load !== undefined && load.status === "loaded")
            return normalized;

        // If we can't wait for the module to load, we are done.
        if (sync) {
            // Throw a `SyntaxError`. *Rationale:* `SyntaxError` is already
            // used for a few conditions that can be detected statically
            // (before a script begins to execute) but are not really syntax
            // errors per se.  Reusing it seems better than inventing a new
            // Error subclass.
            throw $SyntaxError("eval: module not loaded: \"" + normalized + "\"");
        }

        // If the module is already loading, we are done.
        if (load !== undefined) {
            $Assert(load.status === "loading");
            return normalized;
        }

        // From this point `@import` cannot throw.

        // Create a `Load` object for this module load.  Once this object is in
        // `this.@loads`, `LinkSets` may add themselves to its set of waiting
        // link sets.  Errors must be reported to `load.fail()`.
        load = new Load([normalized]);
        $MapSet(this.@loads, normalized, load);

        let address, type;
        try {
            // Call the `resolve` hook.
            let result = this.resolve(normalized, {referer, metadata});

            // Interpret the result.
            type = "module";
            if (typeof result === "string") {
                address = result;
            } else if (IsObject(result)) {
                // `result.address` must be present and must be a string.
                if (!("address" in result)) {
                    throw $TypeError("Object returned from loader.resolve hook " +
                                     "must have a .address property");
                }
                address = result.address;
                if (typeof address !== "string") {
                    throw $TypeError(".address property of object returned from " +
                                     "loader.resolve hook must be a string");
                }

                // `result.extra` is optional, but if present must be an
                // iterable object, a collection of module names.  It indicates
                // that the resource at `result.address` is a script containing
                // those modules.  (The module we're loading, named by
                // `normalized`, may be present in `result.extra` or not.)
                //
                // This means the loader can merge the following imports in
                // a single load:
                //
                //     import "a" as a, "b" as b;
                //
                // if it knows in advance the address of a script that contains
                // module declarations for both `a` and `b`.
                //
                if ("extra" in result) {
                    let extra = result.extra;
                    if (!IsObject(extra)) {
                        throw $TypeError(
                            ".extra property of object returned from " +
                            "loader.resolve hook must be an object");
                    }

                    let names = [...extra];

                    // Record a load in progress for all other modules defined
                    // in the same script.
                    for (let i = 0; i < names.length; i++) {
                        let name = names[i];
                        if (typeof name !== "string")
                            throw $TypeError("module names must be strings");
                        if (name !== normalized) {
                            if ($MapHas(this.@modules, name)) {
                                throw $TypeError(
                                    "loader.resolve hook claims module \"" +
                                    name + "\" is at <" + address + "> but " +
                                    "it is already loaded");
                            }

                            let existingLoad = $MapGet(this.@loads, name);
                            if (existingLoad === undefined) {
                                $ArrayPush(load.fullNames, name);
                                $MapSet(this.@loads, name, load);
                            } else if (existingLoad !== load) {
                                throw $TypeError(
                                    "loader.resolve hook claims module \"" +
                                    name + "\" is at <" + address + "> but " +
                                    "it is already loading or loaded");
                            }
                        }
                    }

                    type = "script";
                }
            } else {
                throw $TypeError("loader.resolve hook must return a " +
                                 "string or an object with .address");
            }
        } catch (exc) {
            // `load` is responsible for firing error callbacks and removing
            // itself from `this.@loads`.
            load.fail(exc);
            return normalized;
        }

        // Start the fetch.
        this.@callFetch(load, address, referer, metadata, normalized, type);

        return normalized;
    }

    // **`@callFetch`** - Call the fetch hook.  Handle any errors.
    @callFetch(load, address, referer, metadata, normalized, type) {
        // P3 ISSUE: type makes sense here, yes?
        //
        // P3 ISSUE: what about "extra"?
        //
        let options = {referer, metadata, normalized, type};
        let errback = exc => load.fail(exc);

        // *Rationale for `fetchCompleted`:* The fetch hook is user code.
        // Callbacks the Loader passes to it are subject to every variety of
        // misuse; the system must be robust against these hooks being called
        // multiple times.
        //
        // Futures treat extra `resolve()` calls after the first as no-ops; we
        // throw instead, per meeting 2013 April 26.
        //
        // P5 ISSUE: what kind of error to throw when that happens (assuming
        // TypeError).
        //
        let fetchCompleted = false;

        function fulfill(src, actualAddress) {
            if (fetchCompleted)
                throw $TypeError("fetch() fulfill callback: fetch already completed");
            fetchCompleted = true;

            if (typeof src !== "string") {
                let msg = "fulfill callback: first argument must be a string";
                AsyncCall(errback, $TypeError(msg));
                return;
            }
            if (typeof actualAddress !== "string") {
                let msg = "fulfill callback: third argument must be a string";
                AsyncCall(errback, $TypeError(msg));
                return;
            }

            // Even though `fulfill()` will *typically* be called
            // asynchronously from an empty or nearly empty stack, the `fetch`
            // hook may call it from a nonempty stack, even synchronously.
            // Therefore use `AsyncCall` here, at the cost of an extra event
            // loop turn.
            AsyncCall(() =>
                this.@onFulfill(load, metadata, normalized, type, false, src, actualAddress));
        }

        function reject(exc) {
            if (fetchCompleted)
                throw $TypeError("fetch() reject callback: fetch already completed");
            fetchCompleted = true;

            AsyncCall(errback, exc);
        }

        try {
            this.fetch(address, fulfill, reject, options);
        } catch (exc) {
            // Some care is taken here to prevent even a badly-behaved fetch
            // hook from causing errback() to be called twice.
            if (fetchCompleted)
                AsyncCall(() => { throw exc; });
            else
                AsyncCall(errback, exc);
        }
    }

    // **`@onFulfill`** - This is called once a fetch succeeds.
    @onFulfill(load, metadata, normalized, type, sync, src, actualAddress) {
        // If `load` is no longer needed by any `LinkSet`, do nothing.  When
        // one load in a LinkSet fails, we shouldn't continue loading
        // dependencies anyway.
        if ($SetSize(load.linkSets) === 0)
            return;

        try {
            // Check arguments to `fulfill` callback.
            if (typeof src !== "string") {
                throw $TypeError("fetch hook fulfill callback: " +
                                 "first argument must be a string");
            }
            if (typeof actualAddress !== "string") {
                throw $TypeError("fetch hook fulfill callback: " +
                                 "second argument must be a string");
            }

            // Call the `translate` hook.
            src = this.translate(src, {metadata, normalized, type, actualAddress});
            if (typeof src !== "string")
                throw $TypeError("translate hook must return a string");

            // Call the `link` hook, if we are loading a module.
            // P1 ISSUE #28: Should this hook be called when loading a script?
            // Perhaps once per module?
            let linkResult =
                type === "module"
                ? this.link(src, {metadata, normalized, type, actualAddress})
                : undefined;

            // Interpret `linkResult`.  See comment on the `link()` method.
            if (linkResult === undefined) {
                let script = $Parse(this, src, normalized, actualAddress, this.@strict);
                load.finish(this, actualAddress, script, sync);
            } else if (!IsObject(linkResult)) {
                throw $TypeError("link hook must return an object or undefined");
            } else if ($IsModule(linkResult)) {
                if ($MapHas(this.@modules, normalized)) {
                    throw $TypeError("fetched module \"" + normalized + "\" " +
                                     "but a module with that name is already " +
                                     "in the registry");
                }
                let mod = linkResult;
                $MapSet(this.@modules, normalized, mod);
                load.onEndRun();
            } else {
                let mod = null;
                let imports = linkResult.imports;

                // P4 issue: "iterable" vs. "array"
                if (imports !== undefined)
                    imports = [...imports];
                let exports = [...linkResult.exports];
                let execute = linkResult.execute;

                throw TODO;
            }
        } catch (exc) {
            if (sync)
                throw exc;
            else
                load.fail(exc);
        }
    }


    // ## Module registry
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
    get(name) {
        // Throw a TypeError if `name` is not a string.
        if (typeof name !== "string")
            throw $TypeError("module name must be a string");

        let m = $MapGet(this.@modules, name);

        // If the module is in the registry but has never been executed, first
        // synchronously execute the module and any dependencies that have not
        // executed yet.
        if (m !== undefined)
            Loader.@ensureExecuted(m);
        return m;
    }

    // **`has`** - Return `true` if a module with the given full name is in the
    // registry.
    //
    // This doesn't call any hooks or execute any module code.
    //
    has(name) {
        if (typeof name !== "string")
            throw $TypeError("module name must be a string");

        return $MapHas(this.@modules, name);
    }

    // **`set`** - Put a module into the registry.
    set(name, module) {
        if (typeof name !== "string")
            throw $TypeError("module name must be a string");

        // Entries in the module registry must actually be `Module`s.
        // *Rationale:* We use `Module`-specific intrinsics like
        // `$CodeGetLinkedModules` and `$CodeExecute` on them.  The spec will
        // do the same.  per samth, 2013 April 22.
        if (!$IsModule(module))
            throw $TypeError("Module object required");

        // If there is already a module in the registry with the given full
        // name, replace it, but any scripts or modules that are linked to the
        // old module remain linked to it. *Rationale:* Re-linking
        // already-linked modules might not work, since the new module may
        // export a different set of names. Also, the new module may be linked
        // to the old one! This is a convenient way to monkeypatch
        // modules. Once modules are widespread, this technique can be used for
        // polyfilling.
        //
        // If `name` is in `this.@loads`, `.set()` succeeds, with no immediate
        // effect on the pending load; but if that load eventually produces a
        // module-declaration for the same name, that will produce a link-time
        // error. per samth, 2013 April 22.
        //
        $MapSet(this.@modules, name, module);
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
        // If there is no module with the given name in the registry, this does
        // nothing.
        //
        // `loader.delete("A")` has no effect at all if
        // `!loader.@modules.has("A")`, even if "A" is currently loading (an
        // entry exists in `loader.@loads`).  This is analogous to `.set()`.
        // per (reading between the lines) discussions with dherman, 2013 April
        // 17, and samth, 2013 April 22.
        $MapDelete(this.@modules, name);
        return this;
    }


    // ## Loader hooks
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

    // TODO these methods need to check the this-value carefully.  This can
    // be done with a private symbol.

    // **`normalize`** hook - For each `import()` call or import-declaration,
    // the Loader first calls `loader.normalize(name, options)` passing the
    // module name as passed to `import()` or as written in the
    // import-declaration.  This hook returns a full module name which is used
    // for the rest of the import process.  (In particular, modules are stored
    // in the registry under their full module name.)
    //
    // **When this hook is called:** For all imports, including imports in
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
    // **Synchronous calls to `fulfill` and `reject`:**  (P2 ISSUE #9)  The
    // `fetch` hook may call the `fulfill` or `reject` callback synchronously
    // rather than waiting for the next event loop turn.  Per meeting, 2013
    // April 26.
    //
    // I think samth and I agree that a synchronous `fulfill` callback should
    // not synchronously call `translate`/`link` hooks, much less
    // `normalize`/`resolve`/`fetch` hooks for dependencies.  TODO:  Code that
    // up.
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
    //     @ensureExecuted.
    //
    //  2. The hook may return a full Module instance object. The loader
    //     then simply adds that module to the registry.
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

    // ## Globals, builtins, and intrinsics

    // Define all the built-in objects and functions of the ES6 standard
    // library associated with this loader's intrinsics as properties on
    // `obj`.
    defineBuiltins(obj = this.@global) {
        $DefineBuiltins(obj, this);
        return obj;
    }
}


// ## Notes on error handling
//
// Most errors that can occur during a load, asyncEval, or import are related
// to either a specific in-flight `Load` (in `loader.@loads`) or a specific
// `LinkSet`.
//
// When such an error occurs:
//
//  1. Compute the set F of `LinkSet`s we are going to fail.
//
//       * If the error is related to a single `LinkSet` (that is, it
//         is a link error or an execution error in a module or script),
//         then F = a set containing just that `LinkSet`.
//
//       * If the error is related to an in-flight `Load` (that is, it has to
//         do with a hook throwing, returning an invalid value, calling a
//         fulfill callback inorrectly, or calling the reject callback), then F
//         = the set of LinkSets that needed that module.
//
//  2. Let M = the set of all in-flight modules (in loader.@loads) that are not
//     needed by any LinkSet other than those in F.
//
//     P3 ISSUE #20: Can the set M be computed efficiently?
//
//  3. Remove all modules in M from `loader.@loads`.  If any are in "loading"
//     state, neuter the fetch hook's fulfill/reject callbacks so that they
//     become no-ops.
//
//     P4 ISSUE: It would be nice to cancel those fetches, if possible.
//
//  4. Call the `errback` for each `LinkSet` in F.
//
//     P5 ISSUE:  Ordering.  We can spec the order to be the order of
//     the `import()/load()/evalAsync()` calls, wouldn't be hard.
//
// After that, we drop the failed `LinkSet`s and they become garbage.
//
// Note that any modules that are already linked and committed to the module
// registry are unaffected by the error.


// ### Encyclopedia of errors
//
// For reference, here are all the kinds of errors that can
// occur. This list is meant to be exhaustive.
//
// Errors related to a `Load`:
//
//   - For each module, we call all five loader hooks, any of which
//     can throw or return an invalid value.
//
//   - The `normalize`, `resolve`, and `link` hooks may return objects that are
//     then destructured.  These objects could throw from a getter or `Proxy`
//     trap during destructuring.
//
//   - The fetch hook can report an error via the `reject()` callback.
//
//   - We can fetch bad code and get a `SyntaxError` trying to parse it.
//
// Errors related to a `LinkSet`:
//
//   - During linking, we can find that a factory-made module is
//     involved in an import cycle. This is an error.
//
//   - A "static" linking error: a script or module X tries to import
//     a binding from a module Y that isn't among Y's exports.
//
//   - A factory function can throw or return an invalid value.
//
//   - After linking, we add all modules to the registry.  This fails if
//     there's already an entry for any of the module names.
//
//   - Execution of a module body or a script can throw.
//
// Other:
//
//   - The `normalize` hook throws or returns an invalid value.  This happens
//     so early in the load process that there is no `Load` yet.  We can
//     directly call the `errback` hook.  TODO see if this really fits in
//     here...
//
//   - The `fetch` hook errors described above can happen when fetching script
//     code for a `load()` call. Again, this happens very early in the process;
//     no `LinkSet`s and no modules are involved. We can skip the complex
//     error-handling process and just directly call the `errback` hook. (But
//     TODO - it might make more sense to make `load()` use a `LinkSet` too.)


// ## Dependency loading
//
// The goal of a `Load` is to resolve, fetch, translate, and parse a single
// module (or a collection of modules that all live in the same script).
//
// A `Load` is in one of four states:
//
// 1.  Loading:  Source is not available yet.
//
//         .status === "loading"
//         .linkSets is a Set of LinkSets
//
//     The load leaves this state when the source is successfully parsed, or
//     an error causes the load to fail.
//
//     `Load`s in this state are associated with one or more `LinkSet`s in a
//     many-to-many relation. This implementation stores both directions of the
//     relation: `load.linkSets` is the `Set` of all `LinkSet`s that require
//     `load`; and `linkSet.loads` is the `Set` of all `Load`s that `linkSet`
//     requires.
//
// 2.  Loaded:  Source is available and has been translated and parsed.
//     Dependencies have been identified.  But the module hasn't been linked or
//     executed yet.  We are waiting for dependencies.
//
//     This implementation treats the `Module` object as already existing at
//     this point (except for factory-made modules).  But it has not been
//     linked and thus must not be exposed to script yet.
//
//     The `"loaded"` state says nothing about the status of the dependencies;
//     they may all be linked and executed and yet there may not be any
//     `LinkSet` that's ready to link and execute this module.  The `LinkSet`
//     may be waiting for unrelated dependencies to load.
//
//         .status === "loaded"
//         .script is a script or null
//         .factory is a callable object or null
//         .dependencies is an Array of strings (full module names)
//
//     Exactly one of `[.script, .factory]` is non-null.
//
//     The load leaves this state when a `LinkSet` successfully links the
//     module and moves it into the loader's module registry.
//
// 3.  Done:  The module has been linked and added to the loader's module
//     registry.  Its body may or may not have been executed yet (see
//     `ensureExecuted`).
//
//         .status === "linked"
//
//     (TODO: this is speculation) Loads that enter this state are removed from
//     the `loader.@loads` table and from all `LinkSet`s; they become garbage.
//
// 4.  Failed:  The load failed.  The load never leaves this state.
//
//         .status === "failed"
//         .exception is an exception value
//
class Load {
    // If the constructor argument is an array, it is the array of module names
    // that we're loading; the `Load` begins in the `"loading"` state.
    //
    // If the argument is a script, the new `Load` begins in the `"loaded"`
    // state. This happens in `eval()` and `evalAsync()`: the eval script does
    // not need to go through the `"loading"` part of the pipeline, but it must
    // be linked.
    //
    // TODO - consider instead of allowing directly creating `"loaded"`
    // `Load`s, having the caller create it, add it to the `LinkSet`, and then
    // call `finish()` manually.
    //
    constructor(namesOrScript) {
        if ($IsArray(namesOrScript)) {
            this.status = "loading";
            this.fullNames = namesOrScript;
            this.script = null;
            this.dependencies = null;
        } else {
            this.status = "loaded";
            this.fullNames = $ScriptDeclaredModuleNames(script);
            this.script = script;
            this.dependencies = throw TODO;
        }
        this.linkSets = $SetNew();
        this.factory = null;
        this.exception = null;
    }

    // **`finish`** - The loader calls this after the last loader hook (the
    // `link` hook), and after the script or module's syntax has been
    // checked. `finish` does three things:
    //
    //   1. Process module declarations.
    //
    //   2. Process imports. This may trigger additional loads (though if
    //      `sync` is true, it definitely won't: we'll throw instead).
    //
    //   3. Call `.onLoad` on any listening `LinkSet`s (see that method for the
    //      conclusion of the load/link/run process).
    //
    // On success, this transitions the `Load` from `"loading"` status to
    // `"loaded"`.
    //
    finish(loader, actualAddress, script, sync) {
        $Assert(this.status === "loading");
        $Assert($SetSize(this.linkSets) !== 0);

        // Check to see if `script` declares any modules that are already loaded or
        // loading.  If so, throw a `SyntaxError`.  If not, add entries to
        // `loader.@loads` for each declared module.
        //
        // *Rationale:* Consider two `evalAsync` calls.
        //
        //     System.evalAsync('module "x" { import "y" as y; }', ok, err);
        //     System.evalAsync('module "x" { import "z" as z; }', ok, err);
        //
        // There's no sense in letting them race trying to load "y" and "z"
        // after we know one of the two `module "x"` declarations must fail.
        // Instead, the second `evalAsync` fails immediately.  Per meeting,
        // 2013 April 26.
        //
        // TODO - Consider unifying this with similar code in LinkSet.link().
        //
        let declared = $ScriptDeclaredModuleNames(script);
        for (let i = 0; i < declared.length; i++) {
            let fullName = declared[i];
            if ($MapHas(loader.@modules, fullName)) {
                throw $SyntaxError("script declares module \"" + fullName + "\", " +
                                   "which is already loaded");
            }
            let pendingLoad = $MapGet(loader.@loads, fullName);
            if (pendingLoad === undefined) {
                $MapSet(loader.@loads, fullName, this);
            } else if (pendingLoad !== this) {
                throw $SyntaxError("script declares module \"" + fullName + "\", " +
                                   "which is already loading");
            }
        }

        // `$ScriptImports` returns an array of `[client, request]` pairs.
        //
        // `client` tells where the import appears. It is the full name of the
        // enclosing module, or null for toplevel imports.
        //
        // `request` is the name being imported.  It is not necessarily a full
        // name; we pass it to `Loader.@import` which will call the `normalize`
        // hook.
        //
        let pairs = $ScriptImports(script);
        let fullNames = [];
        let sets = this.linkSets;

        // P4 ISSUE: Execution order when multiple LinkSets become linkable
        // at once.
        //
        // Proposed: When a fetch fulfill callback fires and completes the
        // dependency graph of multiple link sets at once, they are
        // linked and executed in the order of the original
        // load()/evalAsync() calls.
        //
        // samth is unsure but thinks probably so.

        // When we load a script, we add all its modules and their
        // dependencies to the same link set, per samth, 2013 April 22.
        //
        // TODO: implement that for the declared modules
        //
        // Example:
        //     module "A" {
        //         import "B" as B;
        //         B.hello();
        //     }
        //     alert("got here");
        //
        // Note that toplevel does not import "A", so the body of "A"
        // will not execute, and we will not call B.hello().
        // Nevertheless, we load "B.js" before executing the script.
        //
        for (let i = 0; i < pairs.length; i++) {
            let [client, request] = pairs[i];
            let referer = {name: client, address: actualAddress};
            let fullName;
            try {
                fullName = loader.@import(referer, request, sync);
            } catch (exc) {
                return this.fail(exc);
            }
            fullNames[i] = fullName;

            for (let j = 0; j < sets.length; j++)
                sets[j].addLoadByName(fullName);
        }

        this.status = "loaded";
        this.script = script;
        this.dependencies = fullNames;
        if (!sync) {
            for (let i = 0; i < sets.length; i++)
                sets[i].onLoad(this);
        }
    }

    // **`onEndRun`** - Called when the `link` hook returns a Module object.
    onEndRun() {
        $Assert(this.status === "loading");
        this.status = "linked";
        for (let i = 0; i < sets.length; i++)
            sets[i].onLoad(this);
    }

    // **`fail`** - Fail this load. All `LinkSet`s that require it also fail.
    fail(exc) {
        $Assert(this.status === "loading");
        this.status = "failed";
        this.exception = exc;
        let sets = $SetElements(this.linkSets);
        for (let i = 0; i < sets.length; i++)
            sets[i].fail(exc);
        $Assert($SetSize(this.linkSets) === 0);
    }

    // **`onLinkSetFail`** - This is called when a LinkSet associated with this
    // load fails.  If this load is not needed by any surviving LinkSet, drop
    // it.
    onLinkSetFail(loader, linkSet) {
        $Assert($SetHas(this.linkSets, linkSet));
        $SetDelete(this.linkSets, linkSet);
        if ($SetSize(this.linkSets) === 0) {
            for (let i = 0; i < this.fullNames.length; i++) {
                let fullName = this.fullNames[i];
                let currentLoad = $MapGet(loader.@loads, fullName);
                if (currentLoad === this)
                    $MapDelete(loader.@loads, fullName);
            }
        }
    }
}

// A `LinkSet` represents a call to `loader.evalAsync()`, `.load()`, or
// `.import()`.
class LinkSet {
    constructor(loader, startingLoad, callback, errback) {
        // TODO: make LinkSets not inherit from Object.prototype, for isolation;
        // or else use symbols for all these; or else use define(). :-P
        this.loader = loader;
        this.startingLoad = startingLoad;
        this.callback = callback;
        this.errback = errback;

        this.loads = $SetNew();

        // Invariant: `this.loadingCount` is the number of `Load`s in
        // `this.loads` whose `.status` is `"loading"`.
        this.loadingCount = 0;

        this.addLoad(startingLoad);
    }

    // **`addLoadByName`** - If a module with the given `fullName` is loading
    // or loaded but not linked, add the `Load` to this link set.
    addLoadByName(fullName) {
        if (!$MapHas(this.loader.@modules, fullName)) {
            // We add `depLoad` even if it is done loading, because the
            // association keeps the `Load` alive (`Load`s are
            // reference-counted; see `Load.onLinkSetFail`).
            let depLoad = $MapGet(this.loader.@loads, fullName);
            this.addLoad(depLoad);
        }
    }

    // **`addLoad`** - Add a `load` to this `LinkSet`.
    //
    // P1 ISSUE: whether to keep a per-LinkSet copy of the relevant slice of
    // the module registry, to avoid the LinkSet, as an algorithm, sharing
    // mutable state with other LinkSets and user code.
    //
    addLoad(load) {
        // This case can happen in `import`, for example if a `resolve` or
        // `fetch` hook throws.
        if (load.status === "failed")
            return this.fail(load.exception);

        if (!$SetHas(this.loads, load)) {
            $SetAdd(this.loads, load);
            $SetAdd(load.linkSets, this);
            if (load.status === "loading") {
                this.loadingCount++;
            } else {
                // Transitively add not-yet-linked dependencies.
                $Assert(load.status == "loaded");
                for (let i = 0; i < load.dependencies.length; i++)
                    this.addLoadByName(load.dependencies[i]);
            }
        }
    }

    // **`onLoad`** - `Load.prototype.finish` calls this after one `Load`
    // successfully finishes, and after kicking off loads for all its
    // dependencies.
    //
    // If this `LinkSet` is completely satisfied (that is, all dependencies
    // have loaded) then we link the modules and fire the success callback.
    //
    // **Timing and grouping of dependencies.** Consider
    //
    //     loader.evalAsync('import "x" as x; import "y" as y;', f);
    //
    // We wait to execute "x" until "y" has also been fetched. Even if "x"
    // turns out to be linkable and runnable, its dependencies are all
    // satisfied, it links correctly, and it has no direct or indirect
    // dependency on "y", we still wait.
    //
    // *Rationale:* Dependencies could be initialized more eagerly, but the
    // order would be less deterministic. The design opts for a bit more
    // determinism in common cases&mdash;though it is easy to trigger
    // non-determinism since multiple link sets can be in-flight at once.
    //
    onLoad(load) {
        $Assert($SetHas(this.loads, load));
        $Assert(load.status === "loaded" || load.status === "linked");
        if (--this.loadingCount === 0) {
            // Link, then schedule the success callback.
            try {
                this.link();
            } catch (exc) {
                this.fail(exc);
                return;
            }

            AsyncCall(this.callback);
        }
    }

    // **`link`** - Link all scripts and modules in this link set to each other
    // and to modules in the registry.  This is done in a synchronous walk of
    // the graph.  On success, commit all the modules in this LinkSet to the
    // loader's module registry.
    link() {
        let linkedNames = [];
        let linkedModules = [];
        let seen = $SetNew();

        // Depth-first walk of the import tree, stopping at already-linked
        // modules.
        function walk(load) {
            // XXX TODO - assert something about load.status here
            let script = load.script;
            $SetAdd(seen, script);

            // First, note all modules declared in this script.
            let declared = $ScriptDeclaredModuleNames(script);
            for (let i = 0; i < declared.length; i++) {
                let fullName = declared[i];
                let mod = $ScriptGetDeclaredModule(script, fullName);

                if ($MapHas(this.loader.@modules, fullName)) {
                    throw $SyntaxError(
                        "script declares module \"" + fullName + "\", " +
                        "which is already loaded");
                }
                if (load === undefined) {
                    if ($MapHas(this.loader.@loads, fullName)) {
                        throw $SyntaxError(
                            "script declares module \"" + fullName + "\", " +
                            "which is already loading");
                    }
                } else {
                    let current = $MapGet(this.loader.@loads, fullName);

                    // These two cases can happen if a script unexpectedly
                    // declares modules not named by resolve().other.
                    if (current === undefined) {
                        // Make sure no other script in the same LinkSet
                        // declares it too.
                        $MapSet(this.loader.@loads, fullName, this);
                    } else if (current !== this) {
                        throw $SyntaxError(
                            "script declares module \"" + fullName + "\", " +
                            "which is already loading");
                    }
                }

                $ArrayPush(linkedNames, fullName);
                $ArrayPush(linkedModules, mod);
            }

            // Second, find modules imported by this script.
            //
            // The loader process walks the whole graph, so all imported
            // modules should be loaded, but it is an asynchronous process.
            // Intervening calls to Loader.set() or Loader.delete() can
            // cause things to be missing.
            //
            let deps = load.dependencies;
            let mods = [];
            for (let i = 0; i < deps.length; i++) {
                let fullName = deps[i];
                let mod = $MapGet(this.loader.@modules, fullName);
                if (mod === undefined) {
                    let depLoad = $MapGet(this.loader.@loads, fullName);
                    if (depLoad === undefined || depLoad.status !== "loaded") {
                        throw $SyntaxError(
                            "module \"" + fullName + "\" was deleted from the loader");
                    }
                    mod = $ScriptGetDeclaredModule(depLoad.script, fullName);
                    if (mod === undefined) {
                        throw $SyntaxError(
                            "module \"" + fullName + "\" was deleted from the loader");
                    }
                    if (!$SetHas(seen, depLoad.script))
                        walk(depLoad);
                }
                $ArrayPush(mods, mod);
            }

            // Finally, link the script.  This throws if the script tries
            // to import bindings from a module that the module does not
            // export.
            $LinkScript(script, mods);
        }

        // Link all the scripts and modules together.
        //
        // TODO: This could throw partway through.  When linking fails, we must
        // rollback any linking we already did up to that point.  Linkage must
        // either happen for all scripts and modules, or fail, atomically.
        // Per dherman, 2013 May 15.
        walk(this.startingLoad);

        // Move the fully linked modules from the `@loads` table to the
        // `@modules` table.
        for (let i = 0; i < linkedNames.length; i++) {
            $MapDelete(this.loader.@loads, linkedNames[i]);
            $MapSet(this.loader.@modules, linkedNames[i], linkedModules[i]);
        }
    }

    // **`fail`** - Fail this `LinkSet`.  Detach it from all loads and schedule
    // the error callback.
    fail(exc) {
        let loads = $SetElements(this.loads);
        for (let i = 0; i < loads.length; i++)
            loads[i].onLinkSetFail(this.loader, this);
        AsyncCall(this.errback, exc);
    }
}


// ## Module and script execution

// **`executedCode`** - The set of all scripts and modules we have ever passed
// to `$CodeExecute()`; that is, everything we've ever tried to execute.
//
// (Of course instead of a hash table, an implementation could implement this
// using a bit per script/module.)
//
var executedCode = $WeakMapNew();

// **`execute`** - Execute the given script or module `c` (but only if we have
// never tried to execute it before).
function execute(code) {
    if (!$WeakMapHas(executedCode, code)) {
        $WeakMapSet(executedCode, code, true);
        return $CodeExecute(code);
    }
}

// **`ensureExecuted`** - Walk the dependency graph of the script or module
// `start`, executing any script or module bodies that have not already
// executed (including, finally, `start` itself).
//
// `start` and its dependencies must already be linked.
//
// On success, `start` and all its dependencies, transitively, will have
// started to execute exactly once.  That is, they will all have been added to
// `executedCode`.
//
// **Purpose** - Module bodies are executed on demand, as late as possible.
// The loader always uses this function to execute scripts, and always calls
// this function before returning a module to script.
//
// **Not-yet-executed modules** - There is one way a module can be exposed to
// script before it has executed.  In the case of an import cycle, whichever
// module executes first can observe the others before they have executed.
// Simply put, we have to start somewhere: one of the modules in the cycle must
// run before the others.
//
// P3 ISSUE: If you `eval()` or `load()` a script S that declares a module M
// and imports a module K, and executing K's body throws, then the next script
// that imports M will cause the body of S to execute. Super weird.
//
function ensureExecuted(start) {
    // **Why the graph walk doesn't stop at already-executed modules:**  It's
    // a matter of correctness.  Here is the test case:
    //
    //     <script>
    //       var ok = false;
    //     </script>
    //     <script>
    //       module "x" { import "y" as y; throw fit; }
    //       module "y" { import "x" as x; ok = true; }
    //       import "y" as y;  // marks "x" as executed, but not "y"
    //     </script>
    //     <script>
    //       import "x" as x;  // must execute "y" but not "x"
    //       assert(ok === true);
    //     </script>
    //
    // When we `ensureExecuted` the third script, module `x` is already marked
    // as executed, but one of its dependencies, `y`, isn't.  In order to
    // achieve the desired postcondition, we must find `y` anyway and execute
    // it.
    //
    // Cyclic imports, combined with exceptions during module execution
    // interrupting this algorithm, are the culprit.
    //
    // The remedy: when walking the dependency graph, do not stop at
    // already-marked-executed modules.
    //
    // (The implementation could optimize this by marking each module with an
    // extra "no need to walk this subtree" bit when all dependencies,
    // transitively, are found to have been executed.)

    // Another test case:
    //
    //     var log = "";
    //     module "x" { import "y" as y; log += "x"; }
    //     module "y" { log += "y"; }
    //     import "x" as x, "y" as y;
    //     assert(log === "xy");

    // Build a *schedule* giving the sequence in which modules and scripts
    // should execute.
    //
    // **Execution order** - *Modules* execute in depth-first, left-to-right,
    // post order, stopping at cycles.
    //
    // The *script* that contains one or more required modules is executed
    // immediately after the last of the modules it declares that are in the
    // dependency set, per dherman, 2013 May 21.
    //
    let seen = $SetNew();
    let schedule = $SetNew();

    function walk(m) {
        $SetAdd(seen, m);
        let deps = $CodeGetLinkedModules(m);
        for (let i = 0; i < deps.length; i++) {
            let dep = deps[i];
            if (!$SetHas(seen, dep))
                walk(dep);
        }
        $SetAdd(schedule, m);

        if ($IsModule(m)) {
            // The `$SetRemove` call here means that if we already plan to
            // execute this script, move it to execute after `m`.
            let script = $ModuleGetDeclaringScript(m);
            $SetRemove(schedule, script);
            $SetAdd(schedule, script);
        }
    }

    walk(start);

    // Run the code.
    //
    // **Exceptions during execution:** - Module bodies can throw exceptions, and they are
    // propagated to the caller.
    //
    // When this happens, we leave the module in the registry (per samth, 2013
    // April 16) because re-loading the module and running it again is not
    // likely to make things better.
    //
    // Other fully linked modules in the same LinkSet are also left in the
    // registry (per dherman, 2013 April 18).  Some of those may be unrelated
    // to the module that threw.  Since their "has ever started executing" bit
    // is not yet set, they will be executed on demand.  This allows unrelated
    // modules to finish loading and initializing successfully, if they are
    // needed.
    //
    // **Nesting** - While executing a module body, calling `eval()` or
    // `System.get()` can cause other module bodies to execute.  That is,
    // module body execution can nest.  However no individual module's body
    // will be executed more than once.
    //
    let result;
    schedule = $SetElements(schedule);
    for (let i = 0; i < schedule.length; i++)
        result = execute(schedule[i]);
    return result;
}


// ## Utility functions

// ES6 ToBoolean abstract operation.
function ToBoolean(v) {
    return !!v;
}

// Return true if Type(v) is Object.
function IsObject(v) {
    // TODO: I don't think this is correct per ES6. There may not be a good way
    // to do it.
    return (typeof v === "object" && v !== null) ||
           typeof v === "function";
}

// Schedule fn to be called with the given arguments during the next turn of
// the event loop.
//
// (This is used to schedule calls to success and failure callbacks, since
// the spec requires that those always be called from an empty stack.)
//
function AsyncCall(fn, ...args) {
    $QueueTask(() => fn(...args));
}

export var System = new Loader;
