// # loaders.js - ES6 module loaders illustrated
//
// This is a sample implementation of the ES6 module loader.
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
//   * the methods for loading and running code:
//     `eval`, `evalAsync`, `load`, and `import`;
//   * the methods for directly accessing the module map:
//     `get`, `has`, `set`, and `delete`;
//   * the loader hooks and the loading pipeline that calls them;
//   * dependency loading;
//   * linking;
//   * evaluation order;
//   * error handling;
//   * the browser's configuration method, `ondemand`;
//   * the browser's custom loader hooks: `normalize`, `resolve`, and `fetch`.
//
// Some parts are not implemented at all yet:
//
//   * an API for compiling modules and putting them into the loader;
//   * making the loader hooks all asynchronous;
//   * support for custom link hooks that create dynamic-linked ("factory-made")
//     modules;
//   * intrinsics;
//   * probably various other odds and ends.
//
//
// ## Primitives
//
// We rely on the JavaScript implementation to provide a few primitives.  You
// can skip over this stuff. On the other hand, it tells what sort of thing
// we'll be doing here.
//
// * `$Assert(condition)` is your bog-standard assert function. It does
//   nothing. The given `condition` is always true.
//
// * `$QueueTask(fn)` schedules a callback `fn` to be called in a later
//   event loop turn.  Much like `setTimeout(fn, 0)`.  The HTML spec calls
//   this "[queueing a
//   task](http://www.whatwg.org/specs/web-apps/current-work/multipage/webappapis.html#queue-a-task)".
//   Here, it&rsquo;s mainly used to ensure that user callbacks are called
//   from an empty stack.
//
// * `$DefineBuiltins(obj)` builds a full copy of the ES builtins on `obj`,
//   so for example you get a fresh new `obj.Array` constructor and methods
//   like `obj.Array.prototype.push`. You even get `obj.Loader`, a copy of
//   `Loader`.
//
// Now on to the core JS language implementation intrinsics.
//
// * `$Parse(loader, src, moduleName, address, strict)` parses a script or
//   module body. If `moduleName` is null, then `src` is parsed as an ES6
//   Script; otherwise `moduleName` is a string, and `src` is parsed as a
//   ModuleBody.  `$Parse` detects ES "early errors" and throws `SyntaxError`
//   or `ReferenceError`.  On success, it returns either a Script object or a
//   ModuleBody object.  This is the only way objects of these types are
//   created.  (Script and ModuleBody objects are never exposed to user code;
//   they are for use with the following intrinsics only.)
//
//   Note that this does not run any of the code in `src`.
//
// The next six primitives operate on both scripts and modules.
//
// * `$DefineConstant(body, name, value)` defines a constant binding in the
//   toplevel declarative environment of `body`, with the given `name` and `value`.
//   This is only used to implement `module a from "A";` declarations, so
//   `value` is always a Module object.
//
// * `$LinkImport(body, name, sourceModule, sourceName)` defines an import
//   binding. `body` is a Module or Script object.
//
//   `sourceModule` is the module in which the desired binding is actually
//   declared (not just as a re-export but as a slot). None of the arguments
//   are export names; both `name` and `sourceName` are binding names.
//
//   The result of `$LinkImport` is that in `body`'s scope, `name` becomes an
//   alias for the binding in `sourceModule`'s scope with the name
//   `sourceName`.
//
//   `name` and `sourceName` are strings. `sourceName` may be `"default"`.
//
// * `$Link(body, modules)` - OBSOLETE. This is used in a non-working
//   implementation of linking, below.
//
// * `$Evaluate(body)` runs the body of a script or module. If `body` is a
//   module, return undefined. If it's a script, return the value of the
//   last-evaluated expression statement (just like `eval`).
//
// * `$GetLinkedModules(body)` - OBSOLETE. Returns an array of the modules
//   linked to `body` in a previous `$Link` call.  (We could perhaps do without
//   this by caching this information in a WeakMap.)
//
// * `ALL`, `MODULE` - Opaque constants related to `$GetLinkingInfo` (below).
//
// * `$GetLinkingInfo(body)` - Returns an Array of objects representing the
//   import/export/module declarations in the given Script or Module.
//
//   The objects all look like this:
//
//       {
//           // These are non-null for declarations which import a module or
//           // import something from a module.
//           importModule: string or null,
//           importName: string or null or ALL or MODULE,
//
//           // This is non-null for declarations which create a module-level
//           // binding.
//           localName: string or null,
//
//           // This is non-null for declarations which export something. (It's
//           // always null in a script because scripts can't have exports.)
//           exportName: string or null or ALL
//       }
//
//   The objects created for each kind of declaration are as follows:
//
//       module x from "A";
//         {importModule: "A", importName: MODULE, localName: "x", exportName: null}
//       import "A";
//         {importModule: "A", importName: MODULE, localName: null, exportName: null}
//       import x from "A";
//         {importModule: "A", importName: "default", localName: "x", exportName: null}
//       import {} from "A";
//         {importModule: "A", importName: MODULE, localName: null, exportName: null}
//       import {x1 as y1} from "A";
//         {importModule: "A", importName: "x1", localName: "y1", exportName: null}
//       export {x1 as y1} from "A";
//         {importModule: "A", importName: "x1", localName: null, exportName: "y1"}
//       export * from "A";
//         {importModule: "A", importName, ALL, localName: null, exportName: ALL}
//       export {x1 as y1};
//         {importModule: null, importName: null, localName: "x1", exportName: "y1"}
//       unless the binding x1 was declared as an import, like `import {z as x1} from "A"`,
//       in which case:
//         {importModule: "A", importName: "z", localName: null, exportName: "y1"}
//       export *;
//         is expressed as multiple elements of the preceding two forms
//       export default = EXPR;
//         {importModule: null, importName: null, localName: null, exportName: "default"}
//
// The next two primitives operate only on modules.
//
// * `$ModuleBodyToModuleObject(body)` returns a `Module` object for
//   the given ModuleBody `body`.
//
//   Modules declared in scripts must be linked and evaluated before they
//   are exposed to user code.
//
// * `$ModuleObjectToModuleBody(module)` returns a ModuleBody object `body`
//   such that `$ModuleBodyToModuleObject(body) === module`.
//
// Loader iterators require a little private state. These could be implemented
// using a WeakMap, but intrinsics are more efficient.
//
// * `$SetLoaderIteratorPrivate(iter, value)` stores `value` in an internal
//   data property of `iter`.
//
// * `$GetLoaderIteratorPrivate(iter)` retrieves the value previously stored
//   using $SetLoaderIteratorPrivate.
//
// The remaining primitives are not very interesting. These are capabilities
// that JS provides via builtin methods. We use primitives rather than the
// builtin methods because user code can delete or replace the methods.
//
// * `$ToString(v)` === ES ToString algorithm ~= ("" + v)
// * `$Apply(f, thisv, args)` ~= thisv.apply(f, args)
// * `$Call(f, thisv, ...args)` ~= thisv.call(f, ...args)
// * `$ObjectDefineProperty(obj, p, desc)` ~= Object.defineProperty(obj, p, desc)
// * `$ObjectGetOwnPropertyNames(obj)` ~= Object.getOwnPropertyNames(obj)
// * `$IsArray(v)` ~= Array.isArray(v)
// * `$ArrayPush(arr, v)` ~= arr.push(v)
// * `$ArrayPop(arr)` ~= arr.pop()
// * `$SetNew()` ~= new Set
// * `$SetHas(set, v)` ~= set.has(v)
// * `$SetAdd(set, v)` ~= set.add(v)
// * `$SetElements(set)` ~= [...set]
// * `$MapNew()` ~= new Map
// * `$MapHas(map, key)` ~= map.has(key)
// * `$MapGet(map, key)` ~= map.get(key)
// * `$MapSet(map, key, value)` ~= map.set(key, value)
// * `$MapDelete(map, key)` ~= map.delete(key)
// * `$MapValues(map)` ~= [...map.values()]
// * `$MapEntriesIterator(map)` ~= map.entries()
// * `$MapKeysIterator(map)` ~= map.keys()
// * `$MapValuesIterator(map)` ~= map.values()
// * `$MapIteratorNext(map)` ~= mapiter.next()
// * `$WeakMapNew()` ~= new WeakMap
// * `$WeakMapGet(map, key)` ~= map.get(key)
// * `$WeakMapSet(map, key, value)` ~= map.set(key, value)
// * `$TypeError(msg)` ~= new TypeError(msg)
// * `$SyntaxError(msg)` ~= new SyntaxError(msg)

// ## Module objects
//
// A Module object:
//
//   * has null [[Prototype]] initially, or perhaps no [[Prototype]] at all
//
//   * has an [[Environment]] internal data property whose value is a
//     Declarative Environment Record (consisting of all bindings declared at
//     toplevel in the module) whose outerEnvironment is a Global Environment
//     Record.
//
//   * has an [[Exports]] internal data property whose value is a List of
//     Export Records, {[[ExportName]]: a String, [[SourceModule]]: a Module,
//     [[BindingName]]: a String}, such that the [[ExportName]]s of the records
//     in the List are each unique.
//
//   * has data properties that correspond exactly to the [[Exports]], and no
//     other properties.
//
//   * has a [[Dependencies]] internal data property, a List of Modules or
//     null.  This is populated at link time by the loader (?) and used by
//     EnsureEvaluated.



// ## The Loader class
//
// The public API of the module loader system is the `Loader` class.
// A Loader is responsible for asynchronously finding, fetching, linking,
// and running modules and scripts.


//> ## Loader Objects
//>
//> Each Loader object has the following internal data properties:
//>
//>   * loader.[[global]] - The global object associated with the loader. All
//>     scripts and modules loaded by the loader run in the scope of this
//>     object. (XXX needs better wording; it is hard to be both precise and
//>     comprehensible on this point)
//>
//>   * loader.[[strict]] - A boolean value, the loader's strictness setting.  If
//>     true, all code loaded by the loader is strict-mode code.
//>
//> These properties are fixed when the Loader is created and can't be
//> changed. In addition, each Loader contains two Lists:
//>
//>   * loader.[[modules]] - A List of Module Records: the module registry.
//>
//>   * loader.[[loads]] - A List of Load Records. These represent ongoing
//>     asynchronous loads of modules or scripts.


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
//   * `fetch(address, fulfill, reject, options)` - Load a module from the
//     given address.
//
//   * `translate(src, options)` - Optionally translate a script or module from
//     some other language to JS.
//
//   * `link(src, options)` - Determine dependencies of a module; optionally
//     convert an AMD/npm/other module to an ES Module object.



//> ### The Loader Constructor

//> #### Loader ( options )

// Implementation note: Since ES6 does not have support for private state or
// private methods, the "internal data properties" of Loader objects are stored
// on a separate object which is not accessible from user code.
//
// So what the specification refers to as `loader.[[modules]]` is implemented
// as `GetLoaderInternalData(loader).modules`.
//
// The simplest way to connect the two objects without exposing this internal
// data to user code is to use a `WeakMap`.
//
let loaderInternalDataMap = $WeakMapNew();

function Loader(options) {
    // Bug:  This calls Loader_create directly.  The spec will instead make
    // `new Loader(options)` call `Loader[@@create]()` implicitly and pass the
    // resulting uninitialized Loader object as the `this` value to this
    // function.  We'll change that when symbols and @@create are implemented.
    var loader = callFunction(Loader_create, Loader);
    var loaderData = $WeakMapGet(loaderInternalDataMap, loader);
    if (loaderData === undefined)
        throw $TypeError("Loader object expected");
    if (loaderData.modules !== undefined)
        throw $TypeError("Loader object cannot be intitialized more than once");

    // Fallible operations.
    var global = options.global;  // P4 ISSUE: ToObject here?
    var strict = ToBoolean(options.strict);

    // Initialize infallibly.
    loaderData.global = global;
    loaderData.strict = strict;
    loaderData.module = $MapNew();

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
    // But when I discussed this with dherman yesterday, I think I made some
    // headway toward convincing him that what's implemented here is the right
    // design. --jto, 29 August 2013.
    //
    function takeHook(name) {
        var hook = options[name];
        if (hook !== undefined) {
            $ObjectDefineProperty(loader, name, {
                configurable: true,
                enumerable: true,
                value: hook,
                writable: true
            });
        }
    }

    takeHook("normalize");
    takeHook("resolve");
    takeHook("fetch");
    takeHook("translate");
    takeHook("link");
    return loader;
}


//> #### Loader [ @@create ] ( )
//>

function Loader_create() {
    var loader = Object.create(this.prototype);
    var internalData = {
        // **`this.modules`** is the module registry.  It maps full
        // module names to `Module` objects.
        //
        // This map only ever contains `Module` objects that have been
        // fully linked.  However it can contain modules whose bodies
        // have not yet been evaluated.  Except in the case of cyclic
        // imports, such modules are not exposed to user code.  See
        // `EnsureEvaluated()`.
        //
        // This is initially undefined but is populated with a new Map
        // when the constructor runs.
        //
        modules: undefined,

        // **`this.loads`** stores information about modules that are
        // loading or loaded but not yet linked.  (TODO - fix that
        // sentence for OnEndRun.)  It maps full module names to `Load`
        // objects.
        //
        // This is stored in the loader so that multiple calls to
        // `loader.load()/.import()/.evalAsync()` can cooperate to fetch
        // what they need only once.
        //
        loads: $MapNew(),

        // Various configurable options.
        global: undefined,
        strict: false
    };

    $WeakMapSet(loaderInternalDataMap, loader, internalData);
    return loader;
}

// Get the internal data for a given `Loader` object.
function GetLoaderInternalData(value) {
    let internalData = $WeakMapGet(loaderInternalDataMap, value);
    if (internalData === undefined)
        throw $TypeError("Loader method called on incompatible object");
    return internalData;
}



//> ### Properties of the Loader Prototype Object
//>
//> The abstract operation thisLoader(*value*) performs the following steps:
//>
//> 1. If Type(*value*) is Object and value has a [[modules]] internal data property, then
//>     1. Let m be *value*.[[modules]].
//>     2. If m is not **undefined**, then return *value*.
//> 2. Throw a **TypeError** exception.
//>
//> The phrase "this Loader" within the specification of a method refers to the
//> result returned by calling the abstract operation thisLoader with the this
//> value of the method invocation passed as the argument.
//>

//> #### Loader.prototype.global
//>
//> `Loader.prototype.global` is an accessor property whose set accessor
//> function is undefined. Its get accessor function performs the following
//> steps:
//>
function Loader_global() {
    //> 1. Let L be this Loader.
    //> 2. Return L.[[global]].
    return GetLoaderInternalData(this).global;
}
//>


//> #### Loader.prototype.strict
//>
//> `Loader.prototype.strict` is an accessor property whose set accessor
//> function is undefined. Its get accessor function performs the following
//> steps:
//>
function Loader_strict() {
    //> 1. Let L be this Loader.
    //> 2. Return L.[[strict]].
    return GetLoaderInternalData(this).strict;
}
//>


// ### Loading and running code
//
// The high-level interface of `Loader` consists of four methods for
// loading and running code.
//
// These are implemented in terms of slightly lower-level building blocks.
// Each of the four methods creates a `LinkSet` object, which is in charge
// of linking, and at least one `Load`.


//> #### Loader.prototype.eval ( src, [ options ] )
//>

// **`eval`** - Evaluate the script src.
//
// src may import modules, but if it directly or indirectly imports a
// module that is not already loaded, a `SyntaxError` is thrown.
//
function Loader_eval(src, options) {
    src = $ToString(src);
    var loaderData = GetLoaderInternalData(this);

    let address = UnpackAddressOption(options, undefined);

    // The loader works in three basic phases: load, link, and evaluate.
    // During the **load phase**, code is loaded and parsed, and import
    // dependencies are traversed.

    // The `Load` object here is *pro forma*; `eval` is synchronous and
    // thus cannot fetch code.
    let load = CreateLoad(null);
    let linkSet = CreateLinkSet(this, load, null, null);

    // Finish loading `src`.  This is the part where, in an *asynchronous*
    // load, we would trigger further loads for any imported modules that
    // are not yet loaded.
    //
    // Instead, here we pass `true` to `onFulfill` to indicate that we're
    // doing a synchronous load.  This makes it throw rather than trigger
    // any new loads or add any still-loading modules to the link set.  If
    // this doesn't throw, then we have everything we need and load phase
    // is done.
    //
    OnFulfill(this, load, {}, null, "script", true, src, address);

    // The **link phase** links each imported name to the corresponding
    // module or export.
    LinkLinkSet(linkSet);

    // During the **evaluate phase**, we first evaluate module bodies
    // for any modules needed by `script` that haven't already run.
    // Then we evaluate `script` and return that value.
    return EnsureEvaluated(script);
}


//> #### Loader.prototype.evalAsync ( src, options, callback, errback )
//>

// **`evalAsync`** - Asynchronously run the script src, first loading any
// imported modules that aren't already loaded.
//
// This is the same as `load` but without fetching the initial script.
// On success, the result of evaluating the program is passed to
// callback.
//
function Loader_evalAsync(src,
                          options,
                          callback = value => {},
                          errback = exc => { throw exc; })
{
    src = $ToString(src);
    var loaderData = GetLoaderInternalData(this);

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
    let address = UnpackAddressOption(options, errback);
    if (address === undefined)
        return;

    let load = CreateLoad(null);
    let run = MakeEvalCallback(load, callback, errback);
    CreateLinkSet(this, load, run, errback);
    OnFulfill(this, load, {}, null, "script", false, src, address);
}

//>
//> The `length` property of the `evalAsync` method is **2**.
//>

//> #### Loader.prototype.load ( address, callback, errback, options )
//>

// **`load`** - Asynchronously load and run a script.  If the script
// contains import declarations, this can cause modules to be loaded,
// linked, and evaluated.
//
// On success, pass the result of evaluating the script to the success
// callback.
//
// This is the same as `asyncEval`, but first fetching the script.
//
function Loader_load(address,
                     callback = value => {},
                     errback = exc => { throw exc; },
                     options = undefined)
{
    // Build a referer object.
    let refererAddress = UnpackAddressOption(options, errback);
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

    let load = CreateLoad(null);
    let run = MakeEvalCallback(load, callback, errback);
    CreateLinkSet(this, load, run, errback);
    return CallFetch(this, load, address, referer, metadata, null, "script");
}
//>
//> The `length` property of the `load` method is **1**.
//>


//> #### Loader.prototype.import ( moduleName, callback, errback, options )
//>

// **`import`** - Asynchronously load, link, and evaluate a module and any
// dependencies it imports.  On success, pass the `Module` object to the
// success callback.
//
function Loader_import(moduleName,
                       callback = module => {},
                       errback = exc => { throw exc; },
                       options = undefined)
{
    // Unpack `options`.  Build the referer object that we will pass to
    // `startModuleLoad`.
    let name = null;
    if (options !== undefined && "module" in options) {
        name = options.module;
        if (typeof name !== "string") {
            AsyncCall(errback, $TypeError("import: options.module must be a string"));
            return;
        }
    }
    let address = UnpackAddressOption(options, errback);
    if (address === undefined)
        return;
    let referer = {name, address};

    // `StartModuleLoad` starts us along the pipeline.
    let load;
    try {
        load = StartModuleLoad(this, referer, moduleName, false);
    } catch (exc) {
        AsyncCall(errback, exc);
        return;
    }

    if (load.status === "linked") {
        // We already had this module in the registry.
        AsyncCall(success);
    } else {
        // The module is now loading.  When it loads, it may have more
        // imports, requiring further loads, so put it in a LinkSet.
        CreateLinkSet(this, load, success, errback);
    }

    function success() {
        let m = load.status === "linked"
            ? load.module
            : $ModuleBodyToModuleObject(load.body);
        try {
            if (m === undefined) {
                throw $TypeError("import(): module \"" + load.fullName +
                                 "\" was deleted from the loader");
            }
            EnsureEvaluated(m);
        } catch (exc) {
            return errback(exc);
        }
        return callback(m);
    }
}
//>
//> The `length` property of the `import` method is **1**.
//>


//> #### Loader.prototype.define ( names, moduleBodies, callback, errback )
//>
function Loader_define(names, moduleBodies, callback, errback) {
    // ISSUE: Two separate iterables is dumb. Why not an iterable of pairs?
    // Then you could pass in a Map, and the semantics below would not be so
    // bizarre.
    let loaderData = GetLoaderInternalData(this);

    let linkSet = undefined;
    let loads = [];
    try {
        let nameSet = $SetNew();
        for (let name of names) {
            if (typeof name !== "string")
                throw $TypeError("define(): argument 1 must be an iterable of strings");
            if ($SetHas(nameSet, name))
                throw $TypeError("define(): argument 1 contains a duplicate entry '" + name + "'");
            if ($MapHas(loaderData.modules, name))
                throw $TypeError("define(): module already loaded: '" + name + "'");
            if ($MapHas(loaderData.loads, name))
                throw $TypeError("define(): module already loading: '" + name + "'");
            $SetAdd(nameSet, name);
        }
        names = $SetElements(nameSet);
        moduleBodies = [...moduleBodies];
        if (names.length !== moduleBodies.length)
            throw $TypeError("define(): names and moduleBodies must be the same length");

        if (names.length === 0) {
            AsyncCall(success);
            return;
        }

        // Make a LinkSet.
        // Pre-populate it with phony Load objects for the given modules.
        // Kick off real Loads for any additional modules imported by the given moduleBodies.
        // Let the link set finish loading, and run the real linking algorithm.
        // Success callback does the rest.
        for (let i = 0; i < names.length; i++) {
            let fullName = names[i];
            let load = CreateLoad(fullName);
            $MapSet(loaderData.loads, fullName, load);
            if (linkSet === undefined)
                linkSet = CreateLinkSet(this, load, success, errback);
            else
                AddLoadToLinkSet(linkSet, load);
            $ArrayPush(loads, load);
        }
    } catch (exc) {
        if (linkSet === undefined)
            AsyncCall(errback, exc);
        else
            LinkSetFailed(linkSet, exc);
    }

    for (let i = 0; i < names.length; i++) {
        // TODO: This status check is here because I think OnFulfill could
        // cause the LinkSet to fail, which may or may not have cause all the
        // other loads to fail. Need to try to observe this happening.
        if (loads[i].status === "loading")
            OnFulfill(this, loads[i], {}, names[i], "module", false, moduleBodies[i], null);
    }

    function success() {
        // ISSUE: need to cope with Loader.prototype.set()/delete() having been
        // called in the mean time so that Loader_get returns some
        // other module, or null. Probably need to catch errors here and
        // route them to errback.
        let arr = [];
        try {
            for (let i = 0; i < names.length; i++)
                $ArrayPush(arr, callFunction(Loader_get, this, names[i]));
        } catch (exc) {
            AsyncCall(errback, exc);
            return;
        }
        return callback(arr);
    }
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


// ### Module registry
//
// Each `Loader` has a **module registry**, a cache of already loaded and
// linked modules.  The Loader uses this map to avoid fetching modules
// multiple times.
//
// The methods below support directly querying and modifying the registry.
// They are synchronous and never fire any loader hooks or trigger new
// loads.


//> #### Loader.prototype.get ( name )
//>

// **`get`** - Get a module by name from the registry.  The argument `name`
// is the full module name.
//
// Throw a TypeError if `name` is not a string.
//
// If the module is in the registry but has never been evaluated, first
// synchronously evaluate the bodies of the module and any dependencies
// that have not evaluated yet.
//
function Loader_get(name) {
    let loaderData = GetLoaderInternalData(this);

    // Throw a TypeError if `name` is not a string.
    if (typeof name !== "string")
        throw $TypeError("module name must be a string");

    let m = $MapGet(loaderData.modules, name);

    if (m !== undefined)
        EnsureEvaluated(m);
    return m;
}


//> #### Loader.prototype.has ( name )
//>

// **`has`** - Return `true` if a module with the given full name is in the
// registry.
//
// This doesn't call any hooks or run any module code.
//
function Loader_has(name) {
    let loaderData = GetLoaderInternalData(this);

    if (typeof name !== "string")
        throw $TypeError("module name must be a string");

    return $MapHas(loaderData.modules, name);
}


//> #### Loader.prototype.set ( name, module )
//>

// **`set`** - Put a module into the registry.
function Loader_set(name, module) {
    let loaderData = GetLoaderInternalData(this);

    if (typeof name !== "string")
        throw $TypeError("module name must be a string");

    // Entries in the module registry must actually be `Module`s.
    // *Rationale:* We use `Module`-specific intrinsics like
    // `$GetLinkedModules` and `$Evaluate` on them.  per samth,
    // 2013 April 22.
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
    // If `name` is in `this.loads`, `.set()` succeeds, with no immediate
    // effect on the pending load; but if that load eventually produces a
    // module-declaration for the same name, that will produce a link-time
    // error. per samth, 2013 April 22.
    //
    $MapSet(loaderData.modules, name, module);

    return this;
}


//> #### Loader.prototype.delete ( name )
//>

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
// **`.delete()` and already-linked modules:** `loader.delete("A")` removes
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
function Loader_delete(name) {
    let loaderData = GetLoaderInternalData(this);

    // If there is no module with the given name in the registry, this does
    // nothing.
    //
    // `loader.delete("A")` has no effect at all if
    // `!loaderData.modules.has("A")`, even if "A" is currently loading (an
    // entry exists in `loaderData.loads`).  This is analogous to `.set()`.
    // per (reading between the lines) discussions with dherman, 2013 April
    // 17, and samth, 2013 April 22.
    $MapDelete(loaderData.modules, name);

    return this;
}


//> #### *LoaderIterator*.prototype.next ( )
//>
function LoaderIterator(iterator) {
    $SetLoaderIteratorPrivate(this, iterator);
}

function LoaderIterator_next() {
    return $MapIteratorNext($GetLoaderIteratorPrivate(this));
}


//> #### Loader.prototype[@@iterator] ( )
//> #### Loader.prototype.entries ( )
//>
function Loader_entries() {
    let loaderData = GetLoaderInternalData(this);
    return new LoaderIterator($MapEntriesIterator(loaderData.modules));
}


//> #### Loader.prototype.keys ( )
//>
function Loader_keys() {
    let loaderData = GetLoaderInternalData(this);
    return new LoaderIterator($MapKeysIterator(loaderData.modules));
}

//> #### Loader.prototype.values ( )
//>
function Loader_values() {
    let loaderData = GetLoaderInternalData(this);
    return new LoaderIterator($MapValuesIterator(loaderData.modules));
}


//> #### Loader.prototype.normalize ( name, options )
//>
//> This hook receives the module name as passed to `import()` or as written in
//> the import-declaration. It returns a full module name which is used for the
//> rest of the import process.  (In particular, modules are stored in the
//> registry under their full module name.)
//>
//> *When this hook is called:*  For all imports, including imports in
//> scripts.  It is not called for the main script body evaluated by a call
//> to `loader.load()`, `.eval()`, or `.evalAsync()`.
//>
//> After calling this hook, if the full module name is in the registry,
//> loading stops. Otherwise loading continues, calling the `resolve`
//> hook.
//>
//> The `normalize` hook may also create a custom "metadata" value that will
//> be passed automatically to the other hooks in the pipeline.
//>
//> Returns either:
//>
//>   - a string, the full module name.  The loader will create a new empty
//>     Object to serve as the metadata object for the rest of the load. Or:
//>
//>   - an object that has a `.normalized` property that is a string, the
//>     full module name, and an optional `.metadata` property that the
//>     loader will pass to the other hooks.
//>
//> *Default behavior:*  Return the module name unchanged.
//>
//> When the normalize method is called, the following steps are taken:
//>
function Loader_normalize(name, options) {
    //> 1. Return name.
    return name;
}
//>


//> #### Loader.prototype.resolve ( normalized, options )
//>
//> Given a full module name, determine the resource address (URL, path,
//> etc.) to load.
//>
//> The `resolve` hook is also responsible for determining whether the
//> resource in question is a module or a script.
//>
//> The hook may return:
//>
//>   - a string, the resource address. In this case the resource is a
//>     module.
//>
//>   - an object that has a `.address` property which is a string, the
//>     resource address.  The object may also have a `.extra` property,
//>     which if present must be an iterable of strings, the names of the
//>     modules defined in the script at the given address.
//>
//> *When this hook is called:*  For all imports, immediately after the
//> `normalize` hook returns successfully, unless the module is already
//> loaded or loading.
//>
//> *Default behavior:*  Return the module name unchanged.
//>
//> NOTE The browser's `System.resolve` hook is considerably more complex.
//>
//> When the resolve method is called, the following steps are taken:
//>
function Loader_resolve(normalized, options) {
    //> 1. Return normalized.
    return normalized;
}
//>


//> #### Loader.prototype.fetch ( address, fulfill, reject, options )
//>
//> Asynchronously fetch the requested source from the given address
//> (produced by the `resolve` hook).
//>
//> This is the hook that must be overloaded in order to make the `import`
//> keyword work.
//>
//> The fetch hook should load the requested address and call the fulfill
//> callback, passing two arguments: the fetched source, as a string; and the
//> actual address where it was found (after all redirects), also as a string.
//>
//> options.type is the string `"module"` when fetching a standalone
//> module, and `"script"` when fetching a script.
//>
//> *When this hook is called:* For all modules and scripts whose source
//> is not directly provided by the caller.  It is not called for the
//> script bodies evaluated by `loader.eval()` and `.evalAsync()`, since
//> those do not need to be fetched.  `loader.evalAsync()` can trigger
//> this hook, for modules imported by the script.  `loader.eval()` is
//> synchronous and thus never triggers the `fetch` hook.
//>
//> (`loader.load()` does not call `normalize`, `resolve`, or `link`, since
//> we're loading a script, not a module; but it does call the `fetch` and
//> `translate` hooks, per samth, 2013 April 22.)
//>
//> *Default behavior:*  Pass a `TypeError` to the reject callback.
//>
//> *Synchronous calls to fulfill and reject:*  The `fetch` hook may
//> call the fulfill or reject callback synchronously rather than
//> waiting for the next event loop turn.  fulfill schedules the pipeline
//> to resume asynchronously.  Per meeting, 2013 April 26.  *Rationale:* It
//> would be strange for a synchronous fulfill callback to synchronously
//> call `translate`/`link` hooks, and then `normalize`/`resolve`/`fetch`
//> hooks for dependencies, before the first `fetch` hook has returned.
//>
//> When the fetch method is called, the following steps are taken:
//>
function Loader_fetch(address, fulfill, reject, options) {
    //> TODO
    AsyncCall(() => reject($TypeError("Loader.prototype.fetch was called")));
}
//>


//> #### Loader.prototype.translate ( src, options )
//>
//> Optionally translate src from some other language into ECMAScript.
//>
//> *When this hook is called:*  For all modules and scripts.  (It is not
//> decided whether this is called for direct eval scripts; see issue #8.)
//>
//> *Default behavior:*  Return src unchanged.
//>
//> When the translate method is called, the following steps are taken:
//>
function Loader_translate(src, options) {
    //> 1. Return src.
    return src;
}
//>


//> #### Loader.prototype.link ( src, options )
//>
//> Allow a loader to optionally override the default linking behavior.  There
//> are three options.
//>
//>  1. The link hook may return `undefined`. The loader then uses the
//>     default linking behavior.  It parses src as a script or module
//>     body, looks at its imports, loads all dependencies asynchronously,
//>     and finally links them as a unit and adds them to the registry.
//>
//>     The module bodies will then be evaluated on demand; see
//>     `EnsureEvaluated`.
//>
//>  2. The hook may return a full `Module` instance object.  The loader
//>     then simply adds that module to the registry.
//>
//>  3. *(unimplemented)* The hook may return a factory object which the
//>     loader will use to create the module and link it with its clients
//>     and dependencies.
//>
//>     The form of a factory object is:
//>
//>         {
//>             imports: <array of strings (module names)>,
//>             ?exports: <array of strings (property names)>,
//>             execute: <function (Module, Module, ...) -> Module>
//>         }
//>
//>     The array of exports is optional.  If the hook does not specify
//>     exports, the module is dynamically linked.  In this case, it is
//>     executed during the linking process.  First all of its
//>     dependencies are executed and linked, and then passed to the
//>     relevant execute function.  Then the resulting module is linked
//>     with the downstream dependencies.  This requires incremental
//>     linking when such modules are present, but it ensures that
//>     modules implemented with standard source-level module
//>     declarations can still be statically validated.
//>
//>     (This feature is provided in order to support using `import` to
//>     import pre-ES6 modules such as AMD modules. See
//>     issue #19.)
//>
//> *When this hook is called:*  After the `translate` hook, for modules
//> only.
//>
//> *Default behavior:*  Return undefined.
//>
//> When the link method is called, the following steps are taken:
//>
function Loader_link(src, options) {
    //> 1. Return **undefined**.
}
//>


//> #### Loader.prototype.defineBuiltins ( obj )
//>

// Define all the built-in objects and functions of the ES6 standard
// library associated with this loader's intrinsics as properties on
// `obj`.
function Loader_defineBuiltins(obj = GetLoaderInternalData(this).global) {
    $DefineBuiltins(obj, this);
    return obj;
}
//>
//> The `length` property of the `defineBuiltins` method is **0**.
//>


// **`UnpackAddressOption`** - Used by several Loader methods to get
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
function UnpackAddressOption(options, errback) {
    if (options !== undefined && "address" in options) {
        // BUG: this property access can throw, and we don't catch it and
        // forward to errback.
        let address = options.address;
        if (typeof address !== "string") {
            let exc = $TypeError("options.address must be a string, if present");

            // `errback` is undefined if and only if the caller is synchronous
            // `eval()`.  In that case, just throw.
            if (errback === undefined)
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

// **`MakeEvalCallback`** - Create and return a callback, to be called
// after linking is complete, that evaluates the script loaded by the
// given `load`.
function MakeEvalCallback(load, callback, errback) {
    return () => {
        // Tail calls would be equivalent to AsyncCall, except for
        // possibly some imponderable timing details.  This is meant as
        // a reference implementation, so we just literal-mindedly do
        // what the spec is expected to say.
        let result;
        try {
            result = EnsureEvaluated(load.body);
        } catch (exc) {
            AsyncCall(errback, exc);
            return;
        }
        AsyncCall(callback, result);
    };
}


// ## The loader pipeline

// **`startModuleLoad`** - The common implementation of the `import()`
// method and the processing of `import` declarations in ES code.
//
// There are several possible outcomes:
//
// 1.  Getting `loader.normalize` throws, or the `normalize` hook isn't
//     callable, or it throws an exception, or it returns an invalid value.
//     In these cases, `startModuleLoad` throws.
//
// 2.  The `normalize` hook returns the name of a module that is already in
//     the registry.  `startModuleLoad` returns a pair, the normalized name
//     and a fake Load object.
//
// 3.  This is a synchronous import (for `eval()`) and the module is not
//     yet loaded.  `startModuleLoad` throws.
//
// 4.  In all other cases, either a new `Load` is started or we can join
//     one already in flight.  `startModuleLoad` returns a pair, the
//     normalized name and the `Load` object.
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
function StartModuleLoad(loader, referer, name, sync) {
    var loaderData = GetLoaderInternalData(loader);

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
        let result = loader.normalize(request, {referer});

        // Interpret the `result`.
        //
        // It must be a string or an object with a `.normalized` property
        // whose value is a string.  Otherwise a `TypeError` is thrown.
        // per samth, 2013 April 22, as amended by issue #13.
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
    let existingModule = $MapGet(loaderData.modules, normalized);
    if (existingModule !== undefined)
        return {status: "linked", fullName: normalized, module: existingModule};

    // If the module is already loaded, we are done.
    let load = $MapGet(loaderData.loads, normalized);
    if (load !== undefined && load.status === "loaded")
        return load;

    // If we can't wait for the module to load, we are done.
    if (sync) {
        // Throw a `SyntaxError`. *Rationale:* `SyntaxError` is already
        // used for a few conditions that can be detected statically
        // (before a script begins to run) but are not really syntax
        // errors per se.  Reusing it seems better than inventing a new
        // Error subclass.
        throw $SyntaxError("eval: module not loaded: \"" + normalized + "\"");
    }

    // If the module is already loading, we are done.
    if (load !== undefined) {
        $Assert(load.status === "loading");
        return load;
    }

    // From this point `StartModuleLoad` cannot throw.

    // Create a `Load` object for this module load.  Once this object is in
    // `loaderData.loads`, `LinkSets` may add themselves to its set of waiting
    // link sets.  Errors must be reported using `LoadFailed(load, exc)`.
    load = CreateLoad(normalized);
    $MapSet(loaderData.loads, normalized, load);

    let address;
    try {
        // Call the `resolve` hook.
        address = loader.resolve(normalized, {referer, metadata});
    } catch (exc) {
        // `load` is responsible for firing error callbacks and removing
        // itself from `loaderData.loads`.
        LoadFailed(load, exc);
        return load;
    }

    // Start the fetch.
    CallFetch(loader, load, address, referer, metadata, normalized, "module");

    return load;
}

// **`callFetch`** - Call the fetch hook.  Handle any errors.
function CallFetch(loader, load, address, referer, metadata, normalized, type) {
    let options = {referer, metadata, normalized, type};
    let errback = exc => LoadFailed(load, exc);

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

        if ($SetSize(load.linkSets) === 0)
            return;

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
                  OnFulfill(loader, load, metadata, normalized, type, false, src, actualAddress));
    }

    function reject(exc) {
        if (fetchCompleted)
            throw $TypeError("fetch() reject callback: fetch already completed");
        fetchCompleted = true;
        if ($SetSize(load.linkSets) !== 0)
            AsyncCall(errback, exc);
    }

    try {
        loader.fetch(address, fulfill, reject, options);
    } catch (exc) {
        // Some care is taken here to prevent even a badly-behaved fetch
        // hook from causing errback() to be called twice.
        if (fetchCompleted)
            AsyncCall(() => { throw exc; });
        else
            AsyncCall(errback, exc);
    }
}

// **`onFulfill`** - This is called once a fetch succeeds.
function OnFulfill(loader, load, metadata, normalized, type, sync, src, actualAddress) {
    // TODO - simplify since type is always "module" if normalized is non-null
    // and "script" otherwise.
    $Assert(typeof src === "string");

    var loaderData = GetLoaderInternalData(loader);

    // If all link sets that required this load have failed, do nothing.
    if ($SetSize(load.linkSets) === 0)
        return;

    try {
        // Check arguments to `fulfill` callback.
        // ISSUE - What are the type requirements on addresses, exactly?  We
        // already did this in CallFetch, but not from other call sites.
        if (typeof actualAddress !== "string") {
            throw $TypeError("fetch hook fulfill callback: " +
                             "second argument must be a string");
        }

        // Call the `translate` hook.
        src = loader.translate(src, {metadata, normalized, type, actualAddress});
        if (typeof src !== "string")
            throw $TypeError("translate hook must return a string");

        // Call the `link` hook, if we are loading a module.
        let linkResult =
            type === "module"
            ? loader.link(src, {metadata, normalized, type, actualAddress})
            : undefined;

        // Interpret `linkResult`.  See comment on the `link()` method.
        if (linkResult === undefined) {
            let body = $Parse(loader, src, normalized, actualAddress, loaderData.strict);
            FinishLoad(load, loader, actualAddress, body, sync);
        } else if (!IsObject(linkResult)) {
            throw $TypeError("link hook must return an object or undefined");
        } else if ($IsModule(linkResult)) {
            if ($MapHas(loaderData.modules, normalized)) {
                throw $TypeError("fetched module \"" + normalized + "\" " +
                                 "but a module with that name is already " +
                                 "in the registry");
            }
            let mod = linkResult;
            $MapSet(loaderData.modules, normalized, mod);
            OnEndRun(load, mod);
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
        LoadFailed(load, exc);
    }
}



// ## Notes on error handling
//
// Most errors that can occur during a load, asyncEval, or import are related
// to either a specific in-flight `Load` (in `loader.loads`) or a specific
// `LinkSet`.
//
// When such an error occurs:
//
//  1. Compute the set F of `LinkSet`s we are going to fail.
//
//       * If the error is related to a single `LinkSet` (that is, it
//         is a link error or an runtime error in a module or script),
//         then F = a set containing just that `LinkSet`.
//
//       * If the error is related to an in-flight `Load` (that is, it has to
//         do with a hook throwing, returning an invalid value, calling a
//         fulfill callback incorrectly, or calling the reject callback), then
//         F = `load.linkSets`.
//
//  2. Detach each `LinkSet` in F from all `Load`s it required.
//
//  3. Let M = the set of all in-flight loads (in `loader.loads`) that are no
//     longer needed by any LinkSet.
//
//  4. Remove all loads in M from `loader.loads`.  If any are in `"loading"`
//     state, make the `fulfill` and `reject` callbacks into no-ops.
//
//     P4 ISSUE: It would be nice to cancel those fetches, if possible.
//
//  5. Call the `errback` for each `LinkSet` in F.
//
//     P5 ISSUE: Ordering.  We can spec the order to be the order of the
//     `import()/load()/evalAsync()` calls, wouldn't be hard; or explicitly
//     make it unspecified.
//
// After that, we drop the failed `LinkSet`s and they become garbage.
//
// Modules that are already linked and committed to the module registry are
// unaffected by the error.
//
//
// ### Encyclopedia of errors
//
// For reference, here are all the kinds of errors that can occur that are
// related to on or more loads in progress. This list is meant to be exhaustive.
//
// Errors related to a `Load`:
//
//   - For each load, whether we're loading a script or a module, we call one
//     or more of the loader hooks.  Getting the hook from the Loader object
//     can trigger a getter that throws.  The value of the hook property can be
//     non-callable.  The hook can throw.  The hook can return an invalid
//     return value.
//
//   - The `normalize`, `resolve`, and `link` hooks may return objects that are
//     then destructured.  These objects could throw from a getter or proxy
//     trap during destructuring.
//
//   - The fetch hook can report an error via the `reject()` callback.
//
//   - We can fetch bad code and get a `SyntaxError` trying to parse it.
//
//   - Once the code is parsed, we call the `normalize` hook for each import in
//     that code; that hook can throw or return an invalid value.
//
// Errors related to a `LinkSet`:
//
//   - If a script or module A tries to import a binding from a module B that
//     isn't among B's exports, that's a static link error. We throw a
//     ReferenceError.
//
//   - Import cycles: If module A has `import {x} from "B"; export x;`, and
//     vice versa, that's a static link error. We throw a SyntaxError. (There
//     are several syntactic variants on this, where imports and exports form a
//     cycle, such that the thing being imported/exported is never actually
//     defined anywhere.)
//
//   - "export * from" cycles: If module A has `export * from "B"`, and vice
//     versa, that's a static link error.  We throw a SyntaxError.
//
//   - During linking, we can find that a factory-made module is
//     involved in an import cycle. This is an error.
//
//   - A factory function can throw or return an invalid value.
//
//   - After linking, we add all modules to the registry.  This fails if
//     there's already an entry for any of the module names.
//
//   - Evaluation of a module body or a script can throw.
//
// Other:
//
//   - The `normalize` hook throws or returns an invalid value when we call it
//     for `loader.import()`.  This happens so early in the load process that
//     there is no `Load` yet.  We can directly call the `errback` hook.


//> ### Dependency loading
//>
//> The Load Record type represents an attempt to locate, fetch, translate, and
//> parse a single module or script.
//>
//> Each Load Record has the following fields:
//>
//>   * load.[[Status]] - One of: `"loading"`, `"loaded"`, `"linked"`, or `"failed"`.
//>
//>   * load.[[FullName]] - The normalized name of the module being loaded, or
//>     **null** if loading a script.
//>
//>   * load.[[LinkSets]] - A List of all LinkSets that require this load to
//>     succeed.  There is a many-to-many relation between Loads and LinkSets.
//>     A single `evalAsync()` call can have a large dependency tree, involving
//>     many Loads.  Many `evalAsync()` calls can be waiting for a single Load,
//>     if they depend on the same module.
//>
//>   * load.[[Body]] - Once the Load reaches the `"loaded"` state, a Module or
//>     Script syntax tree. (???terminology)
//>
//>   * load.[[Dependencies]] - Once the Load reaches the `"loaded"` state, a
//>     List of pairs. Each pair consists of two strings: a module name as it
//>     appears in an `import` or `export from` declaration in load.[[Body]],
//>     and the corresponding normalized module name.
//>
//>   * load.[[Exception]] - If load.[[Status]] is `"failed"`, the exception
//>     value that was thrown, causing the load to fail. Otherwise, **null**.
//>
//>   * load.[[ExportedNames]] - A List of strings, names exported by this
//>     module; or **undefined** if this is a script Load or the export set has
//>     not been computed yet.
//>
//>   * load.[[Module]] - If the `.link()` hook returned a Module object,
//>     this is that Module. Otherwise, **null**.
//>
// The spec text currently uses only .[[Module]] and makes .[[ExportedNames]]
// an internal property of the Module object.
//
// Implementation note: We also use this linkingInfo thing, not sure if that needs
// to be part of the standard since it's a pure function of the syntax tree.
//
// Implementation node: This implementation uses a special value of 0 as an
// intermediate value for load.exportedNames, to indicate that the value is
// being computed. This is necessary to detect `export * from` cycles. The spec
// uses a List named *visited* for this purpose.


// The goal of a Load is to locate, fetch, translate, and parse a single
// module.
//
// A Load is in one of four states:
//
// 1.  Loading:  Source is not available yet.
//
//         .status === "loading"
//         .linkSets is a Set of LinkSets
//
//     The load leaves this state when (a) the source is successfully parsed;
//     (b) an error causes the load to fail; or (c) the `link` loader hook
//     returns a Module object.
//
// 2.  Loaded:  Source is available and has been translated and parsed.
//     Dependencies have been identified.  But the module hasn't been
//     linked or evaluated yet.  We are waiting for dependencies.
//
//     This implementation treats the `Module` object as already
//     existing at this point (except for factory-made modules).  But it
//     has not been linked and thus must not be exposed to script yet.
//
//     The `"loaded"` state says nothing about the status of the
//     dependencies; they may all be linked and evaluated and yet there
//     may not be any `LinkSet` that's ready to link and evaluate this
//     module.  The `LinkSet` may be waiting for unrelated dependencies
//     to load.
//
//         .status === "loaded"
//         .body is a Script or ModuleBody, or null
//         .linkingInfo is an Array of objects representing all
//             import, export, and module declarations in .body;
//             see $GetLinkingInfo() for details
//         .dependencies is a Map of strings (module requests)
//             to strings (full module names)
//         .factory is a callable object or null
//
//     Exactly one of `[.body, .factory]` is non-null.
//     If .body is null, then .linkingInfo and .dependencies are null.
//
//     The load leaves this state when a LinkSet successfully links the
//     module and moves it into the loader's module registry.
//
// 3.  Done:  The module has been linked and added to the loader's module
//     registry.  Its body may or may not have been evaluated yet (see
//     `EnsureEvaluated`).
//
//         .status === "linked"
//         .module is a Module object
//
//     (TODO: this is not true in the case of the `link` loader hook returning
//     a Module object; may want a separate status for that) Loads that enter
//     this state are removed from the `loader.loads` table and from all
//     LinkSets; they become garbage.
//
// 4.  Failed:  The load failed.  The load never leaves this state.
//
//         .status === "failed"
//         .exception is an exception value
//

//> #### CreateLoad(fullName) Abstract Operation
//>
// A new `Load` begins in the `"loading"` state.
//
// If the argument fullName is `null`, we are loading a script. Otherwise we
// are loading a module, and fullName is the full name of that module.
//
function CreateLoad(fullName) {
    return {
        status: "loading",
        fullName: fullName,
        linkSets: $SetNew(),
        body: null,
        linkingInfo: null,
        dependencies: null,
        factory: null,
        exception: null,
        exportedNames: undefined,
        module: null
    };
}

//> #### FinishLoad(load, loader, actualAddress, body, sync) Abstract Operation
//>
// The loader calls this after the last loader hook (the `link` hook), and
// after the script or module's syntax has been checked. FinishLoad does two
// things:
//
//   1. Process imports. This may trigger additional loads (though if
//      `sync` is true, it definitely won't: we'll throw instead).
//
//   2. Call LinkSetOnLoad on any listening LinkSets (see that abstract
//      operation for the conclusion of the load/link/run process).
//
// On success, this transitions the `Load` from `"loading"` status to
// `"loaded"`.
//
function FinishLoad(load, loader, actualAddress, body, sync) {
    $Assert(load.status === "loading");
    $Assert($SetSize(load.linkSets) !== 0);

    let refererName = load.fullName;
    let fullNames = [];
    let sets = load.linkSets;

    let linkingInfo = $GetLinkingInfo(body);

    // P4 ISSUE: Evaluation order when multiple LinkSets become linkable
    // at once.
    //
    // Proposed: When a fetch fulfill callback fires and completes the
    // dependency graph of multiple link sets at once, they are
    // linked and evaluated in the order of the original
    // load()/evalAsync() calls.
    //
    // samth is unsure but thinks probably so.

    // Find all dependencies by walking the list of import-declarations.  For
    // each new dependency, create a new Load and add it to the same link set.
    //
    // The module-specifiers in import-declarations, and thus the .importModule
    // fields of the objects in `linkingInfo`, are not necessarily full names.
    // We pass them to StartModuleLoad which will call the `normalize` hook.
    //
    let dependencies = $MapNew();
    for (let i = 0; i < linkingInfo.length; i++) {
        let request = linkingInfo[i].importModule;
        if (!$MapHas(names, request)) {
            let referer = {name: refererName, address: actualAddress};
            let depLoad;
            try {
                depLoad = StartModuleLoad(loader, referer, request, sync);
            } catch (exc) {
                return load.fail(exc);
            }
            $MapSet(dependencies, request, depLoad.fullName);

            if (depLoad.status !== "linked") {
                for (let j = 0; j < sets.length; j++)
                    AddLoadToLinkSet(sets[j], depLoad);
            }
        }
    }

    load.status = "loaded";
    load.body = body;
    load.linkingInfo = linkingInfo;
    load.dependencies = dependencies;
    if (!sync) {
        for (let i = 0; i < sets.length; i++)
            LinkSetOnLoad(sets[i], load);
    }
}

//> #### OnEndRun(load, mod) Abstract Operation
//>
// Called when the `link` hook returns a Module object.
function OnEndRun(load, mod) {
    $Assert(load.status === "loading");
    load.status = "linked";
    load.module = mod;
    load.exportedNames = $ObjectGetOwnPropertyNames(mod);
    for (let i = 0; i < sets.length; i++)
        LinkSetOnLoad(sets[i], load);
}

//> #### LoadFailed(load, exc) Abstract Operation
//>
//> Mark load as having failed. All `LinkSet`s that require it also
//> fail.
//>
function LoadFailed(load, exc) {
    $Assert(load.status === "loading");
    load.status = "failed";
    load.exception = exc;
    let sets = $SetElements(load.linkSets);
    for (let i = 0; i < sets.length; i++)
        LinkSetFailed(sets[i], exc);
    $Assert($SetSize(load.linkSets) === 0);
}


//> ### Link sets
//>
//> A *link set* represents a call to `loader.eval()`, `.evalAsync()`,
//> `.load()`, or `.import()`.
//>
//> #### CreateLinkSet(loader, startingLoad, callback, errback) Abstract Operation
//>
function CreateLinkSet(loader, startingLoad, callback, errback) {
    var linkSet = {
        loader: loader,
        startingLoad: startingLoad,
        callback: callback,
        errback: errback,
        loads: $SetNew(),

        // Invariant: `this.loadingCount` is the number of `Load`s in
        // `this.loads` whose `.status` is `"loading"`.
        loadingCount: 0
    };

    AddLoadToLinkSet(linkSet, startingLoad);
    return linkSet;
}

//> #### LinkSetAddLoadByName(linkSet, fullName) Abstract Operation
//>
//> If a module with the given fullName is loading
//> or loaded but not linked, add the `Load` to the given linkSet.
//>
function LinkSetAddLoadByName(linkSet, fullName) {
    var loaderData = GetLoaderInternalData(linkSet.loader);
    if (!$MapHas(loaderData.modules, fullName)) {
        // We add `depLoad` even if it is done loading, because the
        // association keeps the `Load` alive (`Load`s are
        // reference-counted; see `LinkSetFailed`).
        let depLoad = $MapGet(loaderData.loads, fullName);
        AddLoadToLinkSet(linkSet, depLoad);
    }
}

//> #### AddLoadToLinkSet(linkSet, load) Abstract Operation
//>
function AddLoadToLinkSet(linkSet, load) {
    // This case can happen in `import`, for example if a `resolve` or
    // `fetch` hook throws.
    if (load.status === "failed")
        return LinkSetFailed(linkSet, load.exception);

    if (!$SetHas(linkSet.loads, load)) {
        $SetAdd(linkSet.loads, load);
        $SetAdd(load.linkSets, linkSet);
        if (load.status === "loading") {
            linkSet.loadingCount++;
        } else {
            // Transitively add not-yet-linked dependencies.
            $Assert(load.status == "loaded");
            let fullNames = $MapValues(load.dependencies);
            for (let i = 0; i < fullNames.length; i++)
                LinkSetAddLoadByName(linkSet, fullNames[i]);
        }
    }
}

//> #### LinkSetOnLoad(linkSet, load) Abstract Operation
//>
//> `FinishLoad` calls this after one `Load` successfully finishes, and after
//> kicking off loads for all its dependencies.
//>
function LinkSetOnLoad(linkSet, load) {
    $Assert($SetHas(linkSet.loads, load));
    $Assert(load.status === "loaded" || load.status === "linked");
    if (--linkSet.loadingCount === 0) {
        // If all dependencies have loaded, link the modules and fire the
        // success callback.
        try {
            linkSet.link();
        } catch (exc) {
            LinkSetFailed(linkSet, exc);
            return;
        }

        AsyncCall(linkSet.callback);
    }
}

// **Timing and grouping of dependencies** - Consider
//
//     loader.evalAsync('module x from "x"; module y from "y";', {}, f);
//
// The above code implies that we wait to evaluate "x" until "y" has also
// been fetched. Even if "x" turns out to be linkable and runnable, its
// dependencies are all satisfied, it links correctly, and it has no direct
// or indirect dependency on "y", we still wait.
//
// *Rationale:* Dependencies could be initialized more eagerly, but the
// order would be less deterministic. The design opts for a bit more
// determinism in common cases&mdash;though it is still possible to trigger
// non-determinism since multiple link sets can be in-flight at once.



//> ### Linkage
//>

// **ExplicitExportedNames** - Return the list of names that are definitely
// exported by a given module body, including everything that can be determined
// "locally" (i.e. without looking at other module bodies). Exports due to
// `export *;` are included, since they can be determined by looking at this
// module body, but exports due to `export * from "other";` are not.
function ExplicitExportedNames(linkingInfo) {
    // In the spec, this would be a syntax-directed algorithm.
    //
    // In the implementation, this could be a primitive provided by the parser;
    // but it's also possible to compute it from the output of $GetLinkingInfo,
    // so that's what we do here.
    //
    // This implementation requires that ordinary `export *;` declarations are
    // desugared by $GetLinkingInfo.
    //
    // This returns a Set instead of an Array only because the caller needs the
    // data in a Set.

    let result = $SetNew();
    for (let i = 0; i < linkingInfo.length; i++) {
        let edge = linkingInfo[i];
        let name = edge.exportName;
        if (typeof name === "string") {
            $Assert(!$SetHas(result, name));
            $SetAdd(result, name);
        }
    }
    return result;
}

// **ExportStarRequestNames** - Return an Array of the strings M that occur in
// the syntactic context `export * from M;` in a given module body.
function ExportStarRequestNames(linkingInfo) {
    // In the spec, this would be a syntax-directed algorithm.
    //
    // In the implementation, this could be a primitive provided by the parser;
    // but it's also possible to compute it from the output of $GetLinkingInfo,
    // so that's what we do here.
    //
    let names = [];
    for (let i = 0; i < linkingInfo.length; i++) {
        let edge = linkingInfo[i];
        if (edge.importName === ALL)
            $ArrayPush(names, edge);
    }
    return names;
}

//> #### GetExportedNames(linkSet, load) Abstract Operation
//>
// (This operation is a combination of ComputeLinkage, ExportedNames, and
// ModuleInstanceExportedNames in the draft spec language.)
//
// Implementation note: Instead of the list *visited*, we use a special value
// `load.exportedNames === 0` to indicate that the set of exports is being
// computed right now, and detect `export * from` cycles.
//
function GetExportedNames(linkSet, load) {
    //> 1. If load.[[ExportedNames]] is `"pending"`, throw a SyntaxError
    //>    exception.
    let exports = load.exportedNames;
    if (exports === 0)
        throw SyntaxError("'export * from' cycle detected");

    //> 2. If load.[[ExportedNames]] is not **undefined**, then return load.[[ExportedNames]].
    if (exports !== undefined)
        return exports;

    //> 3. Set load.[[ExportedNames]] to `"pending"`.
    $Assert(load.status === "loaded");
    load.exportedNames = 0;

    //> 4. Let body be the Module parse stored at load.[[Body]].
    //> 5. Let exports be the ExplicitExportedNames of body.
    //
    // Implementation note: As implemented here, steps 5 and 6 each do a pass
    // over load.linkingInfo.  But perhaps both those loops should actually be
    // fused with parsing, and the data should be exposed as primitives by the
    // parser.
    //
    exports = ExplicitExportedNames(load.linkingInfo);

    //> 6. Let names be the ExportStarRequestNames of body.
    let names = ExportStarRequestNames(load.linkingInfo);

    //> 7. Repeat for each requestName in names,
    for (let i = 0; i < names.length; i++) {
        let requestName = names[i];

        //>     1. Let fullName be GetDependencyFullName(load.[[Dependencies]], requestName).
        let fullName = $MapGet(load.dependencies, requestName);

        //>     2. Let mod be GetModuleFromLoaderRegistry(linkSet.[[Loader]], fullName).
        let starExports;
        let mod = $MapGet(loaderData.modules, fullName);
        if (mod !== undefined) {
            //>     3. If mod is not **undefined**,
            //>         1. Let starExports be mod.[[ExportedNames]].
            starExports = $ObjectGetOwnPropertyNames(mod);
        } else {
            //>     4. Else,
            //>          1. Let depLoad be GetLoadFromLoader(linkSet.[[Loader]], fullName).
            let depLoad = $MapGet(loaderData.loads, fullName);

            //>          2. If depLoad is undefined or depLoad.[[Status]] is not `"loaded"`,
            //>             throw a SyntaxError exception.
            if (depLoad === undefined || depLoad.status !== "loaded") {
                throw $SyntaxError(
                    "module \"" + fullName + "\" was deleted from the loader");
            }

            //>          3. Let starExports be GetExportedNames(linkSet, depLoad).
            starExports = GetExportedNames(linkSet, depLoad);
        }

        //>     5. If any name in starExports is already in exports,
        //>        throw a SyntaxError exception.
        //>     6. Add each element of starExports to exports.
        for (let j = 0; j < starExports.length; j++) {
            let name = starExports[j];

            if ($SetHas(exports, name)) {
                throw $SyntaxError(
                    "duplicate export '" + name + "' " +
                        "in module '" + load.fullName + "' " +
                        "due to 'export * from \"" + requestName + "\"'");
            }
            $SetAdd(exports, name);
        }
    }

    //> 8. Set load.[[ExportedNames]] to exports.
    //
    // Implementation note: in the spec, exports is just a List, but in the
    // implementation it is a Set and we want an Array.
    //
    load.exportedNames = $SetElements(exports);

    //> 7. Return exports.
    return exports;
}


//> #### ComputeLinkage(linkSet) Abstract Operation
//>
function ComputeLinkage(linkSet) {
    let components = $SetElements(linkSet.loads);
    for (let i = 0; i < components.length; i++) {
        let load = components[i];
        $Assert(load.status === "loaded" || load.status === "linked");
        ComputeLinkageForLoad(load);
    }
}

//> #### LinkComponents(linkSet) Abstract Operation
//>
function LinkComponents(linkSet) {
    let loader = linkSet.loader;
    let components = $SetElements(linkSet.loads);
    for (let i = 0; i < components.length; i++) {
        let load = components[i];
        let edges = load.linkingInfo;
        for (let j = 0; j < edges.length; j++) {
            Link(loader, load, edges[j]);
        }
    }
}

//> #### FindModuleForLink(loader, fullName) Abstract Operation
//>
function FindModuleForLink(loader, fullName) {
    let loaderData = GetLoaderInternalData(loader);
    let fullName = deps[i];
    let mod = $MapGet(loaderData.modules, fullName);
    if (mod !== undefined)
        return mod;

    let depLoad = $MapGet(loaderData.loads, fullName);
    if (depLoad === undefined || depLoad.status !== "loaded") {
        throw $SyntaxError(
            "module \"" + fullName + "\" was deleted from the loader");
    }
    return $ModuleBodyToModuleObject(depLoad.body);
}

//> #### LookupExport(module, externalName) Abstract Operation
//>
function LookupExport(module, externalName) {
    ???
}

//> #### Link(loader, load, edge) Abstract Operation
//>
function Link(loader, load, edge) {
    if (edge.importModule !== null) {
        let fullName = $MapGet(load.dependencies, edge.importModule);
        let sourceModule = FindModuleForLink(loader, fullName);
        if (edge.localName !== null) {
            $Assert(edge.exportName === null);
            if (edge.localName === MODULE) {
                $DefineConstant(load.body, edge.localName, sourceModule);
            } else {
                let {module, internalName} = LookupExport(sourceModule, edge.importName);
                $LinkImport(load.body, edge.localName, module, internalName);
            }
        } else if (edge.exportName !== null) {
            // This implementation does not do anything for exports of the form
            // {importModule: null, importName: null, localName: "x", exportName: "y"}
            // It assumes such local exports are handled by $Parse().
            LinkExport(load, edge.exportName, sourceModule, edge.importName, []);
        }
    }
}

/*
TODO:

LinkExport(M: Module, external: string, link: ExportLink, visited: List(ExportReference)) : ExportBinding

    If link.[[Resolved]] = *true* then:
      Let exports = M.[[Exports]].
      Add {[[External]]: external, [[Binding]]: link.[[Binding]]} to exports.
      Return link.[[Binding]].
    Else:
      Let ref = link.[[Reference]].
      If ref is in visited, throw a new SyntaxError.
      Add ref to visited.
      Let b = ResolveExport(ref, visited).
      ReturnIfAbrupt(b).
      Let exports = M.[[Exports]].
      Add {[[External]]: external, [[Binding]]: b} to exports.
      Return b.

ResolveExport(ref: ExportReference, visited: List(ExportReference)) : ExportBinding

    Let M = ref.[[Module]].
    Let external = ref.[[External]].
    Let exports = M.[[Exports]].
    If exports has a record r such that r.external = external, the return r.[[Binding]].
    Let edges = M.[[Linkage]].
    If edges = *undefined* (M is fully linked) then throw a new ReferenceError.
    Let e be the edge in edges such that e.[[LinkType]] = *export* and e.[[Name]] = external.
    If no such edge exists throw a new ReferenceError.
    Let b = LinkExport(M, export, e.[[Link]], visited).
    Return b.
*/


//> #### LinkLinkSet(linkSet) Abstract Operation
//>
//> Link all scripts and modules in linkSet to each other and to modules in the
//> registry.  This is done in a synchronous walk of the graph.  On success,
//> commit all the modules in linkSet to the loader's module registry.
//>
function LinkLinkSet(linkSet) {
    let loaderData = GetLoaderInternalData(linkSet.loader);
    let linkedNames = [];
    let linkedModules = [];
    let seen = $SetNew();


    // Depth-first walk of the import tree, stopping at already-linked
    // modules.
    function walk(load) {
        // XXX TODO - assert something about load.status here
        let body = load.body;
        $SetAdd(seen, body);

        // First, if load is a module, check for errors and add it to the list
        // of modules to link.
        if (load.fullName !== null) {
            let fullName = load.fullName;
            if ($MapHas(loaderData.modules, fullName)) {
                throw $SyntaxError(
                    "script declares module \"" + fullName + "\", " +
                        "which is already loaded");
            }
            if (load === undefined) {
                if ($MapHas(loaderData.loads, fullName)) {
                    throw $SyntaxError(
                        "script declares module \"" + fullName + "\", " +
                            "which is already loading");
                }
            } else {
                let current = $MapGet(loaderData.loads, fullName);

                // These two cases can happen if a script unexpectedly
                // declares modules not named by `resolve().extra`.
                if (current === undefined) {
                    // Make sure no other script in the same LinkSet
                    // declares it too.
                    $MapSet(loaderData.loads, fullName, linkSet);
                } else if (current !== linkSet) {
                    throw $SyntaxError(
                        "script declares module \"" + fullName + "\", " +
                            "which is already loading");
                }
            }

            $ArrayPush(linkedNames, fullName);

            let mod = $ModuleBodyToModuleObject(body);
            $ArrayPush(linkedModules, mod);
        }

        // Second, find modules imported by this script.
        //
        // The load phase walks the whole graph, so all imported modules
        // should be loaded, but it is an asynchronous process.
        // Intervening calls to `loader.set()` or `loader.delete()` can
        // cause things to be missing.
        //
        let deps = $MapValues(load.dependencies);
        let mods = [];
        for (let i = 0; i < deps.length; i++) {
            let fullName = deps[i];
            let mod = $MapGet(loaderData.modules, fullName);
            if (mod === undefined) {
                let depLoad = $MapGet(loaderData.loads, fullName);
                if (depLoad === undefined || depLoad.status !== "loaded") {
                    throw $SyntaxError(
                        "module \"" + fullName + "\" was deleted from the loader");
                }
                mod = $ModuleBodyToModuleObject(depLoad.body);
                if (mod === undefined) {
                    throw $SyntaxError(
                        "module \"" + fullName + "\" was deleted from the loader");
                }
                if (!$SetHas(seen, depLoad.body))
                    walk(depLoad);
            }
            $ArrayPush(mods, mod);
        }

        // Finally, link the script or module.  This throws if the script or
        // module in question tries to import bindings from a module that the
        // module does not export.
        $Link(body, mods);
    }

    // Link all the scripts and modules together.
    //
    // TODO: This could throw partway through.  When linking fails, we must
    // rollback any linking we already did up to that point.  Linkage must
    // either happen for all scripts and modules, or fail, atomically.
    // Per dherman, 2013 May 15.
    walk(linkSet.startingLoad);

    // Move the fully linked modules from the `loads` table to the
    // `modules` table.
    for (let i = 0; i < linkedNames.length; i++) {
        $MapDelete(loaderData.loads, linkedNames[i]);
        $MapSet(loaderData.modules, linkedNames[i], linkedModules[i]);
    }
}

//> #### LinkSetFailed(linkSet, exc) Abstract Operation
//>
//> Mark linkSet as having failed.  Detach it from all loads and
//> schedule the error callback.
//>
function LinkSetFailed(linkSet, exc) {
    let loads = $SetElements(linkSet.loads);
    let loaderData = GetLoaderInternalData(linkSet.loader);
    for (let i = 0; i < loads.length; i++) {
        let load = loads[i];

        // Detach load from linkSet.
        $Assert($SetHas(load.linkSets, linkSet));
        $SetDelete(load.linkSets, linkSet);

        // If load is not needed by any surviving LinkSet, drop it.
        if ($SetSize(load.linkSets) === 0) {
            let fullName = load.fullName;
            if (fullName !== null) {
                let currentLoad = $MapGet(loaderData.loads, fullName);
                if (currentLoad === load)
                    $MapDelete(loaderData.loads, fullName);
            }
        }
    }
    AsyncCall(linkSet.errback, exc);
}



//> ### Module and script evaluation
//>
//> Module bodies are evaluated on demand, as late as possible.  The
//> loader uses the function `EnsureEvaluated`, defined below, to run
//> scripts.  The loader always calls `EnsureEvaluated` before returning
//> a Module object to user code.
//>
//> There is one way a module can be exposed to script before its body
//> has been evaluated.  In the case of an import cycle, whichever
//> module is evaluated first can observe the others before they are
//> evaluated.  Simply put, we have to start somewhere: one of the
//> modules in the cycle must run before the others.
//>
// **`evaluatedBody`** - The set of all scripts and modules we have ever
// passed to `$Evaluate()`; that is, all the code we've ever tried to
// run.
//
// (Of course instead of a hash table, an implementation could implement this
// using a bit per script/module.)
//
var evaluatedBody = $WeakMapNew();

//> #### EvaluateScriptOrModuleOnce(body) Abstract Operation
//>
//> Evaluate the given script or module body, but only if we
//> have never tried to evaluate it before.
//>
function EvaluateScriptOrModuleOnce(body) {
    if (!$WeakMapHas(evaluatedBody, body)) {
        $WeakMapSet(evaluatedBody, body, true);
        return $Evaluate(body);
    }
}

//> #### EnsureEvaluated(start) Abstract Operation
//>
//> Walk the dependency graph of the script or module start, evaluating
//> any script or module bodies that have not already been evaluated
//> (including, finally, start itself).
//>
//> start and its dependencies must already be linked.
//>
//> On success, start and all its dependencies, transitively, will have started
//> to evaluate exactly once.
//>
function EnsureEvaluated(start) {
    // *Why the graph walk doesn't stop at already-evaluated modules:*  It's a
    // matter of correctness.  Here is the test case:
    //
    //     <script>
    //       var ok = false;
    //     </script>
    //     <script>
    //       module "x" { import "y" as y; throw fit; }
    //       module "y" { import "x" as x; ok = true; }
    //       import "y" as y;  // marks "x" as evaluated, but not "y"
    //     </script>
    //     <script>
    //       import "x" as x;  // must evaluate "y" but not "x"
    //       assert(ok === true);
    //     </script>
    //
    // When we `EnsureEvaluated` the third script, module `x` is already
    // marked as evaluated, but one of its dependencies, `y`, isn't.  In
    // order to achieve the desired postcondition, we must find `y`
    // anyway and evaluate it.
    //
    // Cyclic imports, combined with exceptions during module evaluation
    // interrupting this algorithm, are the culprit.
    //
    // The remedy: when walking the dependency graph, do not stop at
    // already-marked-evaluated modules.
    //
    // (The implementation could optimize this by marking each module
    // with an extra "no need to walk this subtree" bit when all
    // dependencies, transitively, are found to have been evaluated.)

    // Build a *schedule* giving the sequence in which modules and scripts
    // should be evaluated.
    //
    // **Evaluation order** - Modules are evaluated in depth-first,
    // left-to-right, post order, stopping at cycles.
    //
    let seen = $SetNew();
    let schedule = $SetNew();

    function walk(m) {
        $SetAdd(seen, m);
        let deps = $GetLinkedModules(m);
        for (let i = 0; i < deps.length; i++) {
            let dep = deps[i];
            if (!$SetHas(seen, dep))
                walk(dep);
        }
        $SetAdd(schedule, m);

        if ($IsModule(m)) {
            // The `$SetRemove` call here means that if we already plan to
            // evaluate this script, move it to be evaluated after `m`.
            let script = $ModuleObjectToModuleBody(m);
            $SetRemove(schedule, script);
            $SetAdd(schedule, script);
        }
    }

    walk(start);

    // Run the code.
    //
    // **Exceptions during evaluation** - Module bodies can throw exceptions,
    // which are propagated to the caller.
    //
    // When this happens, we leave the module in the registry (per samth, 2013
    // April 16) because re-loading the module and running it again is not
    // likely to make things better.
    //
    // Other fully linked modules in the same LinkSet are also left in
    // the registry (per dherman, 2013 April 18).  Some of those may be
    // unrelated to the module that threw.  Since their "has ever
    // started being evaluated" bit is not yet set, they will be
    // evaluated on demand.  This allows unrelated modules to finish
    // loading and initializing successfully, if they are needed.
    //
    // **Nesting** - While evaluating a module body, calling `eval()` or
    // `System.get()` can cause other module bodies to be evaluated.
    // That is, module body evaluation can nest.  However no individual
    // module's body will be evaluated more than once.
    //
    let result;
    schedule = $SetElements(schedule);
    for (let i = 0; i < schedule.length; i++)
        result = EvaluateScriptOrModuleOnce(schedule[i]);
    return result;
}


// ## Utility functions

// ES6 ToBoolean abstract operation.
function ToBoolean(v) {
    return !!v;
}

// Return true if Type(v) is Object.
//
// Perhaps surprisingly, process of elimination is the only correct way to
// implement this.  See [ES5 11.4.3, "The `typeof`
// Operator"](https://people.mozilla.com/~jorendorff/es5.1-final.html#sec-11.4.3).
//
function IsObject(v) {
    return v !== null &&
           v !== undefined &&
           typeof v !== "boolean" &&
           typeof v !== "number" &&
           typeof v !== "string";
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


//> ### The System Object
//>
var System = new Loader;
