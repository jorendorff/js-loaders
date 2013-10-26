// # Loader.js - ES6 module loaders illustrated
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
//   * a method for compiling modules and putting them into the loader:
//     `define`;
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
//   * making the loader hooks all asynchronous;
//   * backward-compatibility support for AMD-style modules ("factory-made modules").


// ## Primitives
//
// We rely on the JavaScript implementation to provide a few primitives.  You
// can skip over this stuff. On the other hand, it tells what sort of thing
// we'll be doing here.
(function (global) {
"use strict";

var std_Function_call = Function.prototype.call,
    std_Function_bind = Function.prototype.bind,
    bind = std_Function_call.bind(std_Function_bind),
    callFunction = bind(std_Function_call, std_Function_call);

// * `$Assert(condition)` is your bog-standard assert function. It does
//   nothing. The given `condition` is always true.
function $Assert(condition) { 
    assert(condition);
}

// * `$QueueTask(fn)` schedules a callback `fn` to be called in a later
//   event loop turn.  Much like `setTimeout(fn, 0)`.  The HTML spec calls
//   this "[queueing a
//   task](http://www.whatwg.org/specs/web-apps/current-work/multipage/webappapis.html#queue-a-task)".
//   Here, it&rsquo;s mainly used to ensure that user callbacks are called
//   from an empty stack.
function $QueueTask(fn) {
    setTimeout(fn, 0);
}

// Now on to the core JS language implementation primitives.
//
// * `$Parse(loader, src, moduleName, address, strict)` parses a script or
//   module body. If `moduleName` is null, then `src` is parsed as an ES6
//   Script; otherwise `moduleName` is a string, and `src` is parsed as a
//   ModuleBody.  `$Parse` detects ES "early errors" and throws `SyntaxError`
//   or `ReferenceError`.  On success, it returns either a Script object or a
//   ModuleBody object.  This is the only way objects of these types are
//   created.  (Script and ModuleBody objects are never exposed to user code;
//   they are for use with the following primitives only.)
//
//   Note that this does not run any of the code in `src`.
//
// The following primitives operate on both scripts and modules.
//
// * `$DefineConstant(component, name, value)` defines a constant binding in
//   the toplevel declarative environment of `component`, with the given `name`
//   and `value`.  This is only used to implement `module a from "A";`
//   declarations, so `value` is always a Module object.
//
// * `$CreateImportBinding(component, name, export)` defines an import binding.
//   `component` is a Module or Script object. `name` is a string, the name of
//   the local binding being bound.  `export` is a value returned by
//   $GetModuleExport(), representing the location of the slot to be bound.
//
//   The effect of `$CreateImportBinding` is that in `component`'s scope,
//   `name` becomes an alias for the binding indicated by `export`.
//
//   `name` must in fact be a name declared by an import declaration in
//   `component`, and it must not already have been bound.
//
// * `$GetComponentDependencies(component)` returns component.[[Dependencies]].
//   This is either undefined or an array of Module objects, the modules whose
//   bodies are to be evaluated before the given component's body.  A return
//   value of undefined means the same thing as returning an empty array to the
//   sole caller, EnsureEvaluated().
//
// * `$SetComponentDependencies(component, deps)` sets component.[[Dependencies]].
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
//         {importModule: null, importName: null, localName: "x1", exportName: "y1", isExplicit: true}
//       unless the binding x1 was declared as an import, like `import {z as x1} from "A"`,
//       in which case:
//         {importModule: "A", importName: "z", localName: null, exportName: "y1", isExplicit: true}
//       export *;
//         is expressed as multiple elements of the preceding two forms, but
//         with isExplicit: false.
//       export x = EXPR;
//         {importModule: null, importName: null, localName: "x", exportName: "x", isExplicit: true}
//       export default = EXPR;
//         {importModule: null, importName: null, localName: "default", exportName: "default"}
//
//   Multiple instances of `export *;` or `export * from "M";` are
//   permitted, but all except the first are ignored.  They do not affect
//   the output of $GetLinkingInfo. (That is, you don't get extra objects
//   for each superfluous declaration.)
//
// The following primitives operate on modules.
//
// * `$CreateModule()` returns a new `Module` object. The object is extensible.
//   It must not be exposed to scripts until it has been populated and frozen.
var $CreateModule = () => Object.create(null);

// * `$IsModule(v)` returns true if `v` is a `Module` object.
//
// * `$ModuleBodyToModuleObject(body)` returns a `Module` object for
//   the given ModuleBody `body`.
//
//   Modules declared in scripts must be linked and evaluated before they
//   are exposed to user code.
//
// * `$GetModuleBody(mod)` returns `mod.[[Body]]`. This is the parse of
//   the module source code, if the Module object `mod` was compiled from
//   JS source, and undefined otherwise.
//
// * `$GetModuleExport(mod, name)` returns information about an export binding.
//   If the module `mod` has an export binding for the given `name`, return an
//   opaque object representing the slot it's bound to.  The only operations on
//   this object are $IsExportImplicit and $LinkPassThroughExport. Otherwise
//   return undefined.
//
// * `$IsExportImplicit(export)` returns true if `export` arises from a
//   declaration of the form `export *;` and false otherwise.
//
// * `$GetModuleExports(mod)` returns a new array containing the names of the
//   export bindings already defined in the module `mod`.
//
// * `$LinkPassThroughExport(mod, name, origin)` creates an export binding on
//   the module `mod` with the given `name`, bound to `origin`.
//
// * `$UnlinkModule(mod)` unlinks the given module. This removes all export
//   bindings and import bindings from the module. The module may be re-linked
//   later.
//
// Loader iterators require a little private state. (These can be implemented
// using a WeakMap, but primitive functions would be more efficient.)
//
// * `$SetLoaderIteratorPrivate(iter, value)` stores `value` in an internal
//   data property of `iter`.
//
// * `$GetLoaderIteratorPrivate(iter)` retrieves the value previously stored
//   using $SetLoaderIteratorPrivate.
//
// The following primitives deal with realms.
//
// * `$RealmNew()` creates a new realm for evaluating module and script code. This
//   can be polyfilled in the browser using techniques like
//
//       https://gist.github.com/wycats/8f5263a0bcc8e818b8e5
//
// * `$Evaluate(realm, global, body)` runs the body of a script or module in the
//   context of a given realm and global object. If `body` is a  module, return
//   undefined. If it's a script, return the value of the last-evaluated expression
//   statement (just like `eval`).
//
// * `$DefineBuiltins(realm, obj)` builds a full copy of the ES builtins on `obj`
//   for the given realm, so for example you get a fresh new `obj.Array`
//   constructor and methods like `obj.Array.prototype.push`. You even get
//   `obj.Loader`, a copy of `Loader`.


// The remaining primitives are not very interesting. These are capabilities
// that JS provides via builtin methods. We use primitives rather than the
// builtin methods because user code can delete or replace the methods.
//
// * `$ObjectDefineProperty(obj, p, desc)` ~= Object.defineProperty(obj, p, desc)
var $ObjectDefineProperty = Object.defineProperty;
// * `$ObjectGetOwnPropertyNames(obj)` ~= Object.getOwnPropertyNames(obj)
var $ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
// * `$ObjectKeys(obj)` ~= Object.keys(obj)
var $ObjectKeys = Object.keys;
// * `$ObjectPreventExtensions(obj)` ~= Object.preventExtensions(obj)
var $ObjectPreventExtensions = Object.preventExtensions;

var unmethod = bind(std_Function_bind, std_Function_call)

// * `$ArrayPush(arr, v)` ~= arr.push(v)
var $ArrayPush = unmethod(Array.prototype.push);
// * `$ArrayPop(arr)` ~= arr.pop()
var $ArrayPop = unmethod(Array.prototype.pop);
// * `$ArraySort(arr, cmp)` ~= arr.sort(cmp)
var $ArraySort = unmethod(Array.prototype.sort);
// * `$SetNew()` ~= new Set
var std_Set = Set;
var $SetNew = () => new std_Set;
// * `$SetSize(set)` ~= set.size
var $SetSize = unmethod(Object.getOwnPropertyDescriptor(Set.prototype, "size").get);
// * `$SetHas(set, v)` ~= set.has(v)
var $SetHas = unmethod(Set.prototype.has);
// * `$SetAdd(set, v)` ~= set.add(v)
var $SetAdd = unmethod(Set.prototype.add);
// * `$SetDelete(set, v)` ~= set.delete(v)
var $SetDelete = unmethod(Set.prototype.delete);
// * `$SetElements(set)` ~= [...set]
var $SetElements = set => [...set];
// * `$MapNew()` ~= new Map
var std_Map = Map;
var $MapNew = () => new std_Map;
// * `$MapHas(map, key)` ~= map.has(key)
var $MapHas = unmethod(Map.prototype.has);
// * `$MapGet(map, key)` ~= map.get(key)
var $MapGet = unmethod(Map.prototype.get);
// * `$MapSet(map, key, value)` ~= map.set(key, value)
var $MapSet = unmethod(Map.prototype.set);
// * `$MapDelete(map, key)` ~= map.delete(key)
var $MapDelete = unmethod(Map.prototype.delete);

function iteratorToArray(iter, next) {
    var a = [];
    for (var x = next(iter); !x.done; x = next(iter))
        $ArrayPush(a, x.value);
    return a;
}
// * `$MapEntriesIterator(map)` ~= map.entries()
var $MapEntriesIterator = unmethod(Map.prototype.entries);
// * `$MapKeys(map)` ~= [...map.keys()]
var $MapKeys = map => iteratorToArray($MapKeysIterator(map), $MapIteratorNext);
// * `$MapKeysIterator(map)` ~= map.keys()
var $MapKeysIterator = unmethod(Map.prototype.keys);
// * `$MapValues(map)` ~= [...map.values()]
var $MapValues = map => iteratorToArray($MapValuesIterator(map), $MapIteratorNext);
// * `$MapValuesIterator(map)` ~= map.values()
var $MapValuesIterator = unmethod(Map.prototype.values);
// * `$MapIteratorNext(map)` ~= mapiter.next()
var $MapIteratorNext = unmethod(new Map().keys().next);
// * `$WeakMapNew()` ~= new WeakMap
var std_WeakMap = WeakMap;
var $WeakMapNew = () => new std_WeakMap;
// * `$WeakMapHas(map, key)` ~= map.has(key)
var $WeakMapHas = unmethod(WeakMap.prototype.has);
// * `$WeakMapGet(map, key)` ~= map.get(key)
var $WeakMapGet = unmethod(WeakMap.prototype.get);
// * `$WeakMapSet(map, key, value)` ~= map.set(key, value)
var $WeakMapSet = unmethod(WeakMap.prototype.set);
// * `$TypeError(msg)` ~= new TypeError(msg)
var $TypeError = TypeError;
// * `$SyntaxError(msg)` ~= new SyntaxError(msg)
var $SyntaxError = SyntaxError;

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
//     undefined.  This is populated at link time by the loader and used by
//     EnsureEvaluated.

function ConstantGetter(value) {
    return function () { return value; };
}

function Module(obj) {
    var mod = $CreateModule();
    var keys = $ObjectKeys(obj);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = obj[key];
        $ObjectDefineProperty(mod, keys[i], {
            configurable: false,
            enumerable: true,
            get: ConstantGetter(value),
            set: undefined
        });
    }
    $ObjectPreventExtensions(mod);
    return mod;
}

Module.prototype = null;


// ## The Loader class
//
// The public API of the module loader system is the `Loader` class.
// A Loader is responsible for asynchronously finding, fetching, linking,
// and running modules and scripts.


//> ## Loader Objects
//>
//> Each Loader object has the following internal data properties:
//>
//>   * loader.[[Global]] - The global object associated with the loader. All
//>     scripts and modules loaded by the loader run in the scope of this
//>     object. (XXX needs better wording; it is hard to be both precise and
//>     comprehensible on this point)
//>
//>   * loader.[[Strict]] - A boolean value, the loader's strictness setting.  If
//>     true, all code loaded by the loader is strict-mode code.
//>
//> These properties are fixed when the Loader is created and can't be
//> changed. In addition, each Loader contains two Lists:
//>
//>   * loader.[[Modules]] - A List of Module Records: the module registry.
//>
//>   * loader.[[Loads]] - A List of Load Records. These represent ongoing
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
//   * `fetch(address, options)` - Load a module from the given address.
//
//   * `translate(src, options)` - Optionally translate a script or module from
//     some other language to JS.
//
//   * `instantiate(src, options)` - Optionally convert an AMD/npm/other module
//     to an ES Module object.



//> ### The Loader Constructor

//> #### Loader ( options )

// Implementation note: Since ES6 does not have support for private state or
// private methods, the "internal data properties" of Loader objects are stored
// on a separate object which is not accessible from user code.
//
// So what the specification refers to as `loader.[[Modules]]` is implemented
// as `GetLoaderInternalData(loader).modules`.
//
// The simplest way to connect the two objects without exposing this internal
// data to user code is to use a `WeakMap`.
//
let loaderInternalDataMap = $WeakMapNew();

function Loader(options={}) {
    // Bug: This calls Loader[@@create] directly.  The spec will instead make
    // `new Loader(options)` equivalent to
    // `Loader.[[Call]](Loader[@@create](), List [options])`.
    // In other words, Loader_create will be called *before* Loader.
    // We'll change that when symbols and @@create are implemented.
    var loader = callFunction(Loader["@@create"], Loader);
    var loaderData = $WeakMapGet(loaderInternalDataMap, loader);
    if (loaderData === undefined)
        throw $TypeError("Loader object expected");
    if (loaderData.modules !== undefined)
        throw $TypeError("Loader object cannot be intitialized more than once");

    // Fallible operations.
    var global = options.global;
    if (global !== undefined && !IsObject(global))
        throw $TypeError("options.global must be an object or undefined");
    var strict = ToBoolean(options.strict);
    var realm = options.realm;
    if (realm === undefined) {
        loaderData.realm = $RealmNew();
    } else {
        if (typeof realm !== "object" || realm === null)
            throw $TypeError("realm must be a Loader object, if defined");
        let realmLoaderData = $WeakMapGet(loaderInternalDataMap, realm);
        if (realmLoaderData === undefined)
            throw $TypeError("realm must be a Loader object, if defined");
        loaderData.realm = realmLoaderData.realm;
    }

    // Initialize infallibly.
    loaderData.global = global;
    loaderData.strict = strict;
    loaderData.module = $MapNew();

    var builtins = {};
    $DefineBuiltins(loaderData.realm, builtins);
    $ObjectDefineProperty(loader, "builtins", {
        configurable: true,
        enumerable: true,
        value: builtins,
        writable: true
    });

    // Hooks provided via `options` are just ordinary properties of the new
    // Loader object.
    //
    // *Rationale*: The Loader class contains default implementations of each
    // hook. This way the hooks can be called unconditionally, and either the
    // user-provided hook or the default is called. Furthermore, Loader
    // subclasses can add methods with the appropriate names and use `super()`
    // to invoke the base-class behavior.
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
    takeHook("instantiate");
    return loader;
}

// This helper function uses Object methods rather than 
function def(obj, props) {
    var names = Object.getOwnPropertyNames(props);
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var desc = Object.getOwnPropertyDescriptor(props, name);
        desc.enumerable = false;
        Object.defineProperty(obj, name, desc);
    }
}

def(global, {Module: Module, Loader: Loader});



//> #### Loader [ @@create ] ( )
//>

function create() {
    var loader = Object.create(this.prototype);
    var internalData = {
        // **`loaderData.modules`** is the module registry.  It maps full
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

        // **`loaderData.loads`** stores information about modules that are
        // loading or loaded but not yet linked.  (TODO - fix that sentence for
        // OnEndRun.)  It maps full module names to `Load` objects.
        //
        // This is stored in the loader so that multiple calls to
        // `loader.load()/.import()/.evalAsync()` can cooperate to fetch
        // what they need only once.
        //
        loads: $MapNew(),

        // Various configurable options.
        global: undefined,
        strict: false,
        realm: undefined,

        // **`loaderData.runtimeDependencies`** stores the
        // should-be-evaluated-before relation for modules.
        runtimeDependencies: $WeakMapNew(),

        nextLinkSetTimestamp: 0
    };

    $WeakMapSet(loaderInternalDataMap, loader, internalData);
    return loader;
}

def(Loader, {"@@create": create});

// Get the internal data for a given `Loader` object.
function GetLoaderInternalData(value) {
    // Loader methods could be placed on wrapper prototypes like String.prototype.
    if (typeof value !== "object")
        throw $TypeError("Loader method called on incompatible primitive");

    let internalData = $WeakMapGet(loaderInternalDataMap, value);
    if (internalData === undefined)
        throw $TypeError("Loader method called on incompatible object");
    return internalData;
}

//> ### Properties of the Loader Prototype Object
//>
//> The abstract operation thisLoader(*value*) performs the following steps:
//>
//> 1. If Type(*value*) is Object and value has a [[Modules]] internal data property, then
//>     1. Let m be *value*.[[Modules]].
//>     2. If m is not **undefined**, then return *value*.
//> 2. Throw a **TypeError** exception.
//>
//> The phrase "this Loader" within the specification of a method refers to the
//> result returned by calling the abstract operation thisLoader with the this
//> value of the method invocation passed as the argument.
//>

def(Loader.prototype, {

    //> #### Loader.prototype.global
    //>
    //> `Loader.prototype.global` is an accessor property whose set accessor
    //> function is undefined. Its get accessor function performs the following
    //> steps:
    //>
    get global() {
        //> 1. Let L be this Loader.
        //> 2. Return L.[[Global]].
        return GetLoaderInternalData(this).global;
    },
    //>

    //> #### Loader.prototype.strict
    //>
    //> `Loader.prototype.strict` is an accessor property whose set accessor
    //> function is undefined. Its get accessor function performs the following
    //> steps:
    //>
    get strict() {
        //> 1. Let L be this Loader.
        //> 2. Return L.[[Strict]].
        return GetLoaderInternalData(this).strict;
    },
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
    eval: function eval_(src, options) {
        src = ToString(src);
        var loaderData = GetLoaderInternalData(this);

        let address = UnpackOption(options, "address");

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
        OnFulfill(this, load, {}, null, true, src, address);

        // The **link phase** links each imported name to the corresponding
        // module or export.
        LinkLinkSet(linkSet);

        // During the **evaluate phase**, we first evaluate module bodies
        // for any modules needed by `script` that haven't already run.
        // Then we evaluate `script` and return that value.
        return EnsureEvaluated(this, script);
    },
    //>


    //> #### Loader.prototype.evalAsync ( src, options, callback, errback )
    //>

    // **`evalAsync`** - Asynchronously run the script src, first loading any
    // imported modules that aren't already loaded.
    //
    // This is the same as `load` but without fetching the initial script.
    // On success, the result of evaluating the program is passed to
    // callback.
    //
    evalAsync: function evalAsync(src,
                                  options,
                                  callback = value => {},
                                  errback = exc => { throw exc; })
    {
        src = ToString(src);
        var loaderData = GetLoaderInternalData(this);

        try {
            let address = UnpackOption(options, "address");
            let load = CreateLoad(null);
            let run = MakeEvalCallback(this, load, callback, errback);
            CreateLinkSet(this, load, run, errback);
            OnFulfill(this, load, {}, null, false, src, address);
        } catch (exn) {
            AsyncCall(errback, exn);
        }
    },
    //>
    //> The `length` property of the `evalAsync` method is **2**.
    //>


    //> #### Loader.prototype.import ( moduleName, options )
    //>

    // **`import`** - Asynchronously load, link, and evaluate a module and any
    // dependencies it imports.  On success, pass the `Module` object to the
    // success callback.
    //
    import: function import_(moduleName,
                             options = undefined)
    {
        var loader = this;

        return new Promise(function (resolver) {
            // Unpack `options`.  Build the referer object that we will pass to
            // StartModuleLoad. (Implementation note: if a Promise's init
            // function throws, the new Promise is automatically
            // rejected. UnpackOption and StartModuleLoad can throw.)

            let name = UnpackOption(options, "module");
            let address = UnpackOption(options, "address");
            let referer = {name: name, address: address};

            // `StartModuleLoad` starts us along the pipeline.
            let load = StartModuleLoad(loader, referer, moduleName, false);

            if (load.status === "linked") {
                // We already had this module in the registry.
                resolver.resolve(load.module);
            } else {
                // The module is now loading.  When it loads, it may have more
                // imports, requiring further loads, so put it in a LinkSet.
                CreateLinkSet(loader, load, success, exc => resolver.reject(exc));
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
                    EnsureEvaluated(loader, m);
                } catch (exc) {
                    resolver.reject(exc);
                    return;
                }
                resolver.resolve(m);
            }
        });
    },
    //>
    //> The `length` property of the `import` method is **1**.
    //>


    //> #### Loader.prototype.define ( names, moduleBodies )
    //>
    define: function define(names, moduleBodies) {
        // ISSUE: Two separate iterables is dumb. Why not an iterable of pairs?
        // Then you could pass in a Map, and the semantics below would not be so
        // bizarre.
        let loader = this;
        let loaderData = GetLoaderInternalData(this);

        if (typeof names === "string" && typeof moduleBodies === "string") {
            names = [names];
            moduleBodies = [moduleBodies];
        }

        return new Promise(function (resolver) {
            let linkSet = undefined;
            let loads = [];
            try {
                let nameSet = $SetNew();
                for (let name of names) {
                    name = ToString(name);
                    if ($SetHas(nameSet, name))
                        throw $TypeError("define(): argument 1 contains a duplicate entry '" + name + "'");
                    $SetAdd(nameSet, name);
                }
                names = $SetElements(nameSet);
                moduleBodies = [...moduleBodies];
                if (names.length !== moduleBodies.length)
                    throw $TypeError("define(): names and moduleBodies must be the same length");

                if (names.length === 0) {
                    resolver.resolve(undefined);
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
                    if (linkSet === undefined) {
                        linkSet = CreateLinkSet(loader, load,
                                                _ => resolver.resolve(undefined),
                                                exc => resolver.reject(exc));
                    } else {
                        AddLoadToLinkSet(linkSet, load);
                    }
                    $ArrayPush(loads, load);
                }
            } catch (exc) {
                if (linkSet === undefined)
                    resolver.reject(exc);
                else
                    FinishLinkSet(linkSet, false, exc);
                return;
            }

            for (let i = 0; i < names.length; i++) {
                // TODO: This status check is here because I think OnFulfill could
                // cause the LinkSet to fail, which may or may not cause all the
                // other loads to fail. Need to try to observe this happening.
                if (loads[i].status === "loading")
                    OnFulfill(loader, loads[i], {}, names[i], false, moduleBodies[i], null);
            }
        });
    },
    //>

    //> #### Loader.prototype.load ( names )
    //>
    load: function load(names) {
        let loader = this;
        let loaderData = GetLoaderInternalData(this);

        if (typeof names === "string")
            names = [names];

        // loader.load([]) succeeds immediately.
        if (names.length === 0)
            return Promise.resolve(undefined);

        return new Promise(function (resolver) {
            let name, address;
            try {
                name = UnpackOption(options, "module");
                address = UnpackOption(options, "address");
            } catch (exn) {
                resolver.resolve(exn);
                return;
            }

            let referer = {name: name, address: address};

            // Make a LinkSet.
            let linkSet;
            for (let i = 0; i < names.length; i++) {
                let moduleName = names[i];
                let load = StartModuleLoad(loader, referer, moduleName, false);
                if (linkSet === undefined) {
                    linkSet = CreateLinkSet(loader, load,
                                            _ => resolver.resolve(undefined),
                                            exc => resolver.reject(exc));
                } else {
                    AddLoadToLinkSet(linkSet, load);
                }
            }
        });
    },


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
    get: function get(name) {
        let loaderData = GetLoaderInternalData(this);
        let m = $MapGet(loaderData.modules, ToString(name));
        if (m !== undefined)
            EnsureEvaluated(this, m);
        return m;
    },
    //>


    //> #### Loader.prototype.has ( name )
    //>

    // **`has`** - Return `true` if a module with the given full name is in the
    // registry.
    //
    // This doesn't call any hooks or run any module code.
    //
    has: function has(name) {
        let loaderData = GetLoaderInternalData(this);
        return $MapHas(loaderData.modules, ToString(name));
    },
    //>


    //> #### Loader.prototype.set ( name, module )
    //>

    // **`set`** - Put a module into the registry.
    set: function set(name, module) {
        let loaderData = GetLoaderInternalData(this);

        name = ToString(name);

        // Entries in the module registry must actually be `Module`s.
        // *Rationale:* We use `Module`-specific intrinsics like
        // `$GetComponentDependencies` and `$Evaluate` on them.  per samth,
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
    },
    //>


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
    delete: function delete_(name) {
        let loaderData = GetLoaderInternalData(this);

        // If there is no module with the given name in the registry, this does
        // nothing.
        //
        // `loader.delete("A")` has no effect at all if
        // `!loaderData.modules.has("A")`, even if "A" is currently loading (an
        // entry exists in `loaderData.loads`).  This is analogous to `.set()`.
        // per (reading between the lines) discussions with dherman, 2013 April
        // 17, and samth, 2013 April 22.
        $MapDelete(loaderData.modules, ToString(name));

        return this;
    }
    //>
});


//> #### *LoaderIterator*.prototype.next ( )
//>
function LoaderIterator(iterator) {
    $SetLoaderIteratorPrivate(this, iterator);
}

function LoaderIterator_next() {
    return $MapIteratorNext($GetLoaderIteratorPrivate(this));
}

def(Loader.prototype, {
    //> #### Loader.prototype[@@iterator] ( )
    //> #### Loader.prototype.entries ( )
    //>
    entries: function entries() {
        let loaderData = GetLoaderInternalData(this);
        return new LoaderIterator($MapEntriesIterator(loaderData.modules));
    },

    //> #### Loader.prototype.keys ( )
    //>
    keys: function keys() {
        let loaderData = GetLoaderInternalData(this);
        return new LoaderIterator($MapKeysIterator(loaderData.modules));
    },

    //> #### Loader.prototype.values ( )
    //>
    values: function values() {
        let loaderData = GetLoaderInternalData(this);
        return new LoaderIterator($MapValuesIterator(loaderData.modules));
    },


    //> #### Loader.prototype.normalize ( name, options )
    //>
    //> This hook receives the module name as passed to `import()` or as written in
    //> the import-declaration. It returns a string, the full module name, which is
    //> used for the rest of the import process.  (In particular, modules are
    //> stored in the registry under their full module name.)
    //>
    //> *When this hook is called:*  For all imports, including imports in
    //> scripts.  It is not called for the main script body evaluated by a call
    //> to `loader.load()`, `.eval()`, or `.evalAsync()`.
    //>
    //> After calling this hook, if the full module name is in the registry,
    //> loading stops. Otherwise loading continues, calling the `resolve`
    //> hook.
    //>
    //> *Default behavior:*  Return the module name unchanged.
    //>
    //> When the normalize method is called, the following steps are taken:
    //>
    normalize: function normalize(name, options) {
        //> 1. Return name.
        return name;
    },
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
    resolve: function resolve(normalized, options) {
        //> 1. Return normalized.
        return normalized;
    },
    //>


    //> #### Loader.prototype.fetch ( address, options )
    //>
    //> Asynchronously fetch the requested source from the given address
    //> (produced by the `resolve` hook).
    //>
    //> This is the hook that must be overloaded in order to make the `import`
    //> keyword work.
    //>
    //> The fetch hook should return a promise for a fetch-result object. It
    //> should then load the requested address asynchronously.  On success, the
    //> Promise must resolve to an object of the form {src: string, address:
    //> string}.  The .src property is the fetched source, as a string; the
    //> .address property is the actual address where it was found (after all
    //> redirects), also as a string.
    //>
    //> options.type is the string `"module"` when fetching a standalone
    //> module, and `"script"` when fetching a script.
    //>
    //> *When this hook is called:* For all modules and scripts whose source is
    //> not directly provided by the caller.  It is not called for the script
    //> bodies evaluated by `loader.eval()` and `.evalAsync()`, or for the
    //> module bodies defined with `loader.define()`, since those do not need
    //> to be fetched.  `loader.evalAsync()` can trigger this hook, for modules
    //> imported by the script.  `loader.eval()` is synchronous and thus never
    //> triggers the `fetch` hook.
    //>
    //> (`loader.load()` does not call `normalize`, `resolve`, or
    //> `instantiate`, since we're loading a script, not a module; but it does
    //> call the `fetch` and `translate` hooks, per samth, 2013 April 22.)
    //>
    //> *Default behavior:*  Pass a `TypeError` to the reject callback.
    //>
    //> *Synchronous calls to fulfill and reject:* The `fetch` hook may call
    //> the fulfill or reject callback directly (for example, if source is
    //> already available).  fulfill schedules the pipeline to resume
    //> asynchronously.  *Rationale:* This is how Futures behave.
    //>
    //> When the fetch method is called, the following steps are taken:
    //>
    fetch: function fetch(address, options) {
        //> 1. Throw a **TypeError** exception.
        AsyncCall(() => reject($TypeError("Loader.prototype.fetch was called")));
    },
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
    translate: function translate(src, options) {
        //> 1. Return src.
        return src;
    },
    //>


    //> #### Loader.prototype.instantiate ( src, options )
    //>
    //> Allow a loader to optionally provide interoperability with other module
    //> systems.  There are three options.
    //>
    //>  1. The instantiate hook may return `undefined`. The loader then uses the
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
    //>             execute: <function (Module, Module, ...) -> Module>
    //>         }
    //>
    //>     The module is executed during the linking process.  First all of
    //>     its dependencies are executed and linked, and then passed to the
    //>     relevant execute function.  Then the resulting module is linked
    //>     with the downstream dependencies.  This requires incremental
    //>     linking when such modules are present, but it ensures that modules
    //>     implemented with standard source-level module declarations can
    //>     still be statically validated.
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
    //> When the instantiate method is called, the following steps are taken:
    //>
    instantiate: function instantiate(src, options) {
        //> 1. Return **undefined**.
    }
    //>
});

// **`UnpackOption`** - Used by several Loader methods to get options
// off of an options object and, if defined, coerce them to strings.
//
// `eval()` and `evalAsync()` accept an optional `options` object.
// `options.address`, if present, is passed to the `translate` and
// `instantiate` hooks as `options.actualAddress`, and to the `normalize` hook
// for each dependency, as `options.referer.address`.  The default loader hooks
// ignore it, though.
//
// (`options.address` may also be stored in the script and used for
// `Error().fileName`, `Error().stack`, and developer tools; but such use
// is outside the scope of the language standard.)
//
function UnpackOption(options, name) {
    if (options === undefined)
        return null;
    let value = options[name];
    if (value === undefined)
        return null;
    return ToString(value);
}


// **`MakeEvalCallback`** - Create and return a callback, to be called
// after linking is complete, that evaluates the script loaded by the
// given `load`.
function MakeEvalCallback(loader, load, callback, errback) {
    return () => {
        // Tail calls would be equivalent to AsyncCall, except for
        // possibly some imponderable timing details.  This is meant as
        // a reference implementation, so we just literal-mindedly do
        // what the spec is expected to say.
        let result;
        try {
            result = EnsureEvaluated(loader, load.body);
        } catch (exc) {
            AsyncCall(errback, exc);
            return;
        }
        AsyncCall(callback, result);
    };
}


// ## The loader pipeline

// **`StartModuleLoad`** - The common implementation of the `import()`
// method and the processing of `import` declarations in ES code.
//
// There are several possible outcomes:
//
// 1.  Getting `loader.normalize` throws, or the `normalize` hook isn't
//     callable, or it throws an exception, or it returns an invalid value.
//     In these cases, `StartModuleLoad` throws.
//
// 2.  The `normalize` hook returns the name of a module that is already in
//     the registry.  `StartModuleLoad` returns a pair, the normalized name
//     and a fake Load object.
//
// 3.  This is a synchronous import (for `eval()`) and the module is not
//     yet loaded.  `StartModuleLoad` throws.
//
// 4.  In all other cases, either a new `Load` is started or we can join
//     one already in flight.  `StartModuleLoad` returns a pair, the
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

    // Call the `normalize` hook to get a normalized module name.  See the
    // comment on `normalize()`.
    //
    // Errors that happen during this step propagate to the caller.
    //
    let normalized = loader.normalize(request, {referer: referer});
    normalized = ToString(normalized);

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

    let metadata = {};

    let address;
    try {
        // Call the `resolve` hook.
        address = loader.resolve(normalized, {metadata: metadata});
    } catch (exc) {
        // `load` is responsible for firing error callbacks and removing
        // itself from `loaderData.loads`.
        LoadFailed(load, exc);
        return load;
    }

    // Start the fetch.
    CallFetch(loader, load, address, metadata, normalized, "module");

    return load;
}

// **`callFetch`** - Call the fetch hook.  Handle any errors.
function CallFetch(loader, load, address, metadata, normalized, type) {
    let options = {metadata: metadata, normalized: normalized, type: type};
    let errback = exc => LoadFailed(load, exc);

    // *Rationale for `fetchCompleted`:* The fetch hook is user code.
    // Callbacks the Loader passes to it are subject to every variety of
    // misuse; the system must be robust against these hooks being called
    // multiple times.
    //
    // Futures treat extra `resolve()` calls after the first as no-ops.
    // At the moment this implementation throws TypeError instead, but the API
    // will transition to Futures.
    //
    let fetchCompleted = false;

    function fulfill(fetchResult) {
        if (fetchCompleted)
            throw $TypeError("fetch() fulfill callback: fetch already completed");
        fetchCompleted = true;

        let src = fetchResult.src;
        let address = fetchResult.address;

        if ($SetSize(load.linkSets) === 0)
            return;

        // Even though `fulfill()` will *typically* be called
        // asynchronously from an empty or nearly empty stack, the `fetch`
        // hook may call it from a nonempty stack, even synchronously.
        // Therefore use `AsyncCall` here, at the cost of an extra event
        // loop turn.
        AsyncCall(() =>
                  OnFulfill(loader, load, metadata, normalized, false, src, address));
    }

    function reject(exc) {
        if (fetchCompleted)
            throw $TypeError("fetch() reject callback: fetch already completed");
        fetchCompleted = true;
        if ($SetSize(load.linkSets) !== 0)
            AsyncCall(errback, exc);
    }

    try {
        loader.fetch(address, options).then(fulfill, reject);
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
function OnFulfill(loader, load, metadata, normalized, sync, src, address) {
    var loaderData = GetLoaderInternalData(loader);

    // If all link sets that required this load have failed, do nothing.
    if ($SetSize(load.linkSets) === 0)
        return;

    try {
        // Call the `translate` hook.
        src = loader.translate(src, {
            metadata: metadata,
            normalized: normalized,
            type: normalized === null ? "script" : "module",
            address: address
        });

        // Call the `instantiate` hook, if we are loading a module.
        let instantiateResult =
            normalized === null
            ? undefined
            : loader.instantiate(src, {
                metadata: metadata,
                normalized: normalized,
                address: address
              });

        // Interpret `instantiateResult`.  See comment on the `instantiate()`
        // method.
        if (instantiateResult === undefined) {
            let body = $Parse(loader, src, normalized, address, loaderData.strict);
            FinishLoad(load, loader, address, body, sync);
        } else if (!IsObject(instantiateResult)) {
            throw $TypeError("instantiate hook must return an object or undefined");
        } else if ($IsModule(instantiateResult)) {
            if ($MapHas(loaderData.modules, normalized)) {
                throw $TypeError("fetched module \"" + normalized + "\" " +
                                 "but a module with that name is already " +
                                 "in the registry");
            }
            let mod = instantiateResult;
            $MapSet(loaderData.modules, normalized, mod);
            OnEndRun(load, mod);
        } else {
            let mod = null;
            let imports = instantiateResult.imports;

            // P4 issue: "iterable" vs. "array"
            if (imports !== undefined)
                imports = [...imports];
            let execute = instantiateResult.execute;

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
//  3. Let M = the set of all in-flight loads (in loader.[[Loads]]) that are no
//     longer needed by any LinkSet.
//
//  4. Remove all loads in M from loader.[[Loads]].  If any are in `"loading"`
//     state, make the `fulfill` and `reject` callbacks into no-ops.
//
//  5. Call the `errback` for each `LinkSet` in F (in timestamp order).
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
// related to one or more loads in progress. This list is meant to be
// exhaustive.
//
// Errors related to a `Load`:
//
//   - For each load, whether we're loading a script or a module, we call one
//     or more of the loader hooks.  Getting the hook from the Loader object
//     can trigger a getter that throws.  The value of the hook property can be
//     non-callable.  The hook can throw.  The hook can return an invalid
//     return value.
//
//   - The `normalize`, `resolve`, and `instantiate` hooks may return objects
//     that are then destructured.  These objects could throw from a getter or
//     proxy trap during destructuring.
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
//   - During linking, we can find that a factory-made module is
//     involved in an import cycle. This is an error.
//
//   - Linking a set of non-factory-made modules can fail in several ways.
//     These are described under "Runtime Semantics: Link Errors".
//
//   - A factory function can throw or return an invalid value.
//
//   - Evaluation of a module body or a script can throw.
//
// Other:
//
//   - The `normalize` hook throws or returns an invalid value when we call it
//     for `loader.import()`.  This happens so early in the load process that
//     there is no `Load` yet.  A call to the `errback` hook is explicitly
//     scheduled.


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
//>     Script parse. (???terminology)
//>
//>   * load.[[Dependencies]] - Once the Load reaches the `"loaded"` state, a
//>     List of pairs. Each pair consists of two strings: a module name as it
//>     appears in an `import` or `export from` declaration in load.[[Body]],
//>     and the corresponding normalized module name.
//>
//>   * load.[[Exception]] - If load.[[Status]] is `"failed"`, the exception
//>     value that was thrown, causing the load to fail. Otherwise, **null**.
//>
//>   * load.[[Exports]] - A List of Records characterizing this module's
//>     exports; or **undefined** if this is a script Load or the exports have
//>     not been computed yet.
//>
//      Implementation note:  load.exports is not quite like the spec's
//      load.[[Exports]].  load.exports only contains names exported using
//      `export * from`.  All other exports are stored in the module object
//      itself.
//
//>   * load.[[Module]] - If the `.instantiate()` hook returned a Module object,
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
//     (b) an error causes the load to fail; or (c) the `instantiate` loader
//     hook returns a Module object.
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
//     (TODO: this is not true in the case of the `instantiate` loader hook
//     returning a Module object; may want a separate status for that) Loads
//     that enter this state are removed from the `loader.loads` table and from
//     all LinkSets; they become garbage.
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

//> #### FinishLoad(load, loader, address, body, sync) Abstract Operation
//>
// The loader calls this after the last loader hook (the `instantiate` hook),
// and after the script or module's syntax has been checked. FinishLoad does
// two things:
//
//   1. Process imports. This may trigger additional loads (though if
//      `sync` is true, it definitely won't: we'll throw instead).
//
//   2. Call LinkSetOnLoad on any listening LinkSets (see that abstract
//      operation for the conclusion of the load/link/evaluate process).
//
// On success, this transitions the `Load` from `"loading"` status to
// `"loaded"`.
//
function FinishLoad(load, loader, address, body, sync) {
    $Assert(load.status === "loading");
    $Assert($SetSize(load.linkSets) !== 0);

    let refererName = load.fullName;
    let fullNames = [];
    let sets = $SetElements(load.linkSets);

    let linkingInfo = $GetLinkingInfo(body);

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
            let referer = {name: refererName, address: address};
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
        // For determinism, finish linkable LinkSets in timestamp order.
        // (NOTE: If it turns out that Futures fire in deterministic
        // order, then there's no point sorting this array here.)
        $ArraySort(sets, (a, b) => b.timestamp - a.timestamp);
        for (let i = 0; i < sets.length; i++)
            LinkSetOnLoad(sets[i], load);
    }
}

//> #### OnEndRun(load, mod) Abstract Operation
//>
// Called when the `instantiate` hook returns a Module object.
function OnEndRun(load, mod) {
    $Assert(load.status === "loading");
    load.status = "linked";
    load.module = mod;
    $Assert(load.exports === undefined);
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

    // For determinism, flunk the attached LinkSets in timestamp order.
    // (NOTE: If it turns out that Futures fire in deterministic
    // order, then there's no point sorting this array here.)
    let sets = $SetElements(load.linkSets);
    $ArraySort(sets, (a, b) => b.timestamp - a.timestamp);
    for (let i = 0; i < sets.length; i++)
        FinishLinkSet(sets[i], false, exc);

    $Assert($SetSize(load.linkSets) === 0);
}


//> ### LinkSet Records
//>
//> A LinkSet Record represents a call to `loader.eval()`, `.evalAsync()`,
//> `.load()`, or `.import()`.
//>
//> Each LinkSet Record has the following fields:
//>
//>   * linkSet.[[Loader]] - The Loader object that created this LinkSet.
//>
//>   * linkSet.[[Callback]] - A value that is called when all dependencies are
//>     loaded and linked together.
//>
//>   * linkSet.[[ErrorCallback]] - A value that is called if an error occurs
//>     during loading or linking.
//>
//>   * linkSet.[[Loads]] - A List of the Load Records that must finish loading
//>     before the modules can be linked and evaluated.
//>

//> #### CreateLinkSet(loader, startingLoad, callback, errback) Abstract Operation
//>
function CreateLinkSet(loader, startingLoad, callback, errback) {
    var loaderData = GetLoaderInternalData(linkSet.loader);
    var linkSet = {
        loader: loader,
        callback: callback,
        errback: errback,
        loads: $SetNew(),
        timestamp: loaderData.nextLinkSetTimestamp++,

        // Implementation note: `this.loadingCount` is not in the spec. This is
        // the number of `Load`s in `this.loads` whose `.status` is
        // `"loading"`. It is an optimization to avoid having to walk
        // `this.loads` and compute this value every time it's needed.
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
        // reference-counted; see `FinishLinkSet`).
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
        return FinishLinkSet(linkSet, false, load.exception);

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
            LinkComponents(linkSet);
        } catch (exc) {
            FinishLinkSet(linkSet, false, exc);
            return;
        }

        FinishLinkSet(linkSet, true, undefined);
    }
}

//> #### FinishLinkSet(linkSet, succeeded, exc) Abstract Operation
//>
//> Detach the given LinkSet Record from all Load Records and schedule either
//> the success callback or the error callback.
//>
function FinishLinkSet(linkSet, succeeded, exc) {
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
        } else {
            // Otherwise, on success, mark linked modules as "linked".
            if (succeeded && load.status === "loaded")
                load.status = "linked";
        }
    }

    if (succeeded)
        AsyncCall(linkSet.callback);
    else
        AsyncCall(linkSet.errback, exc);
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

// Before we reach this stage, we already have dependencies for each newly
// loaded module or script: that is, load.dependencies, a per-Load mapping of
// request names to full module names. (The values of this mapping are the same
// thing as the evaluation-order dependencies.)
//
// The basic algorithm we want to describe in the spec is:
//
// 0. Create a Module object for each module being linked.
// 
// 1. For each module, resolve all `export * from` edges.  This step also
//    computes the complete set of exports for each new module.  The resulting
//    synthetic `export {name} from` edges must be stored somewhere.
// 
// 2. Link all exports. For each module in the link set, for each export,
//    create an export binding and a property on the Module object. 
// 
// 3. For each import, bind it to the corresponding export.
//
// 4. If any error occurred during steps 1-3, discard all the Module objects
//    created in step 0 and linkage fails. Otherwise, linkage succeeds; commit
//    the new, fully linked modules to the loader's module registry.
//
// Implementations have a lot of leeway; they can fuse steps 0 to 3 into a
// single pass over the link set.
//
// Errors can be detected in step 1 (`export * from` cycles, `export *`
// collisions), step 2 (`export from` cycles), or step 3 (imports that do not
// match exports, a module we were depending on was deleted from the Loader).
// If any errors occur, the spec will insert some error token into a Module
// somewhere (details TBD), and then step 4 will reject the LinkSet with an
// exception. If a LinkSet has multiple errors, it is up to the implementation
// which exception is thrown.


// LinkComponents(linkSet) is the entry point to linkage; it implements the
// above algorithm.


// Informal definitions of some functions mentioned in the following section:
//
//   * HasImport(loader, m_1, m_2, name) - true if m_1 imports name from m_2
//
//   * HasExport(m, name) - true if name is among m's exports
//
//   * HasPassThroughExport(loader, [m_1, e_1], [m_2, e_2]) -
//     true if m_1 exports m_2[e_2] as e_1.
//     This must find exports of the following forms:
//         export {x} from "M";
//         export * from "M";  // when M exports x
//         export {x};  // in a module that contains an import declaration for x
//
//   * HasExportStarFrom(loader, load_1, load_2) - true if load_1.body contains
//     an `export * from` declaration for load_2.


//> #### Note: Link-time errors (informative)
//>
//> The following are link-time errors. If any of these exist in the LinkSet
//> when linking starts, then linking will fail, with no side effects except
//> that the LinkSet will be rejected. (All the side effects of linkage are
//> applied to new Module objects that are simply discarded on failure.)
//>
//>   * **`import` failures.**
//>     It is a link-time ReferenceError if an import declaration tries to
//>     import a name from a module but the module doesn't export that name.
//>
//>   * **`export from` cycles.**
//>     It is a link-time SyntaxError if one or more modules mutually import a
//>     name from one another in a cycle, such that all of the exports are
//>     pass-through exports, and none of them refer to an actual binding. For
//>     example:
//>
//>         // in module "A"
//>         export {v} from "B";
//>
//>         // in module "B"
//>         export {v} from "A";  // link error: no binding declared anywhere for v
//>
//>   * **`export * from` cycles.**
//>     It is a link-time SyntaxError if one or more modules mutually
//>     `export * from` one another in a cycle. For example:
//>
//>         // in module "A"
//>         export * from "A";  // link error: 'export * from' cycle
//>
//>   * **`export *` collisions.**
//>     It is a link-time SyntaxError if two `export *` declarations in the
//>     same module would export the same name. For example:
//>
//>         // in module "A"
//>         export var x;
//>
//>         // in module "B"
//>         export var x;
//>
//>         // in module "C"
//>         export * from "A";  // link error: both of these modules
//>         export * from "B";  // export something named 'x'
//>
//>   * **Deleted dependencies.**
//>     It is a link error if there exists a module M and a string fullName
//>     such that all of the following are true:
//>     (TODO - tighten up the wording here)
//>       * a Load Record for M exists in loader,
//>       * fullName is in M.[[Dependencies]],
//>       * there is no Load Record for fullName in loads, and
//>       * there is no LoaderRegistryEntry record for fullName in
//>         loader.[[Modules]].
//>
//>     This can occur only if a module required by a Load in loads was
//>     deleted from the loader's module registry using
//>     Loader.prototype.delete.

// **ApparentExports** - Return the List of export LinkageEdges for a given module
// body, including everything that can be determined "locally" (i.e. without
// looking at other module bodies). Exports due to `export *;` are included,
// since they can be determined by looking at this module body, but exports due
// to `export * from "other";` are not.
function ApparentExports(linkingInfo) {
    // In the spec, this would be a syntax-directed algorithm.
    //
    // In the implementation, this could be a primitive provided by the parser;
    // but it's also possible to compute it from the output of $GetLinkingInfo,
    // so that's what we do here.
    //
    // This implementation requires that ordinary `export *;` declarations are
    // desugared by $GetLinkingInfo.
    //
    // The spec can specify a List. This returns an exportName-keyed Map
    // because the caller needs to look up exports by name quickly.
    //
    let result = $MapNew();
    for (let i = 0; i < linkingInfo.length; i++) {
        let edge = linkingInfo[i];
        let name = edge.exportName;
        if (typeof name === "string") {
            $Assert(!$MapHas(result, name));
            $MapSet(result, name, edge);
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

// **GetComponentImports** - Return an Array that includes one edge for each
// import declaration and each `module ... from` declaration in the given
// script or module.
function GetComponentImports(linkingInfo) {
    let imports = [];
    for (let i = 0; i < linkingInfo.length; i++) {
        let edge = linkingInfo[i];
        if (edge.importModule !== null && edge.localName !== null)
            $ArrayPush(imports, edge);
    }
    return imports;
}

//> #### GetExports(linkSet, load) Abstract Operation
//>
// (This operation is a combination of ComputeLinkage, ExportedNames, and
// ModuleInstanceExportedNames in the draft spec language.)
//
// Returns a Map with string keys and values of type
// `{importModule: string, importName: string, exportName: string}`
// where the key === value.exportName.
//
// Implementation note:  The spec detects `export * from` cycles early.  This
// implementation instead uses a special value `load.exports === 0` to indicate
// that the set of exports is being computed right now, and detect cycles.
//
function GetExports(linkSet, load) {
    $Assert(load.status === "loaded");
    $Assert(load.fullName !== null);

    let mod = $ModuleBodyToModuleObject(load.body);

    //> 1. If load.[[Exports]] is `"pending"`, throw a SyntaxError exception.
    let exports = load.exports;
    if (exports === 0)
        throw $SyntaxError("'export * from' cycle detected");

    //> 2. If load.[[Exports]] is not **undefined**, then return load.[[Exports]].
    if (exports !== undefined)
        return exports;

    //> 3. Set load.[[Exports]] to `"pending"`.
    load.exports = 0;

    //> 4. Let body be the Module parse stored at load.[[Body]].
    //> 5. Let exports be the ApparentExports of body.
    //
    // Implementation note: As implemented here, steps 5 and 6 each do a pass
    // over load.linkingInfo.  But both those loops can be fused with parsing,
    // and the data could be exposed as primitives by the parser.
    //
    // Implementation note: In the spec, exports is just a List of LinkageEdge
    // Records. In the implementation, it is a Map keyed by the local binding
    // ([[Name]]).
    //
    exports = ApparentExports(load.linkingInfo);

    //> 6. Let names be the ExportStarRequestNames of body.
    let names = ExportStarRequestNames(load.linkingInfo);

    //> 7. Repeat for each requestName in names,
    for (let i = 0; i < names.length; i++) {
        let requestName = names[i];

        //>     1. Let fullName be GetDependencyFullName(load.[[Dependencies]], requestName).
        let fullName = $MapGet(load.dependencies, requestName);

        //>     2. Let depMod be GetModuleFromLoaderRegistry(linkSet.[[Loader]], fullName).
        let starExports;
        let depMod = $MapGet(loaderData.modules, fullName);
        if (depMod !== undefined) {
            //>     3. If depMod is not **undefined**,
            //>         1. Let starExports be depMod.[[Exports]].
            starExports = $GetModuleExportNames(depMod);
        } else {
            //>     4. Else,
            //>         1. Let depLoad be GetLoadFromLoader(linkSet.[[Loader]], fullName).
            let depLoad = $MapGet(loaderData.loads, fullName);

            //>         2. If depLoad is undefined, throw a **SyntaxError** exception.
            //>         3. If depLoad.[[Status]] is `"loaded"`,
            //>             1. Let starExports be GetExports(linkSet, depLoad).
            //>         4. Else if depLoad.[[Status]] is `"linked"`,
            //>             1. Let starExports be depLoad.[[Module]].[[Exports]].
            //>         5. Else, throw a **SyntaxError** exception.
            if (depLoad === undefined ||
                (depLoad.status !== "loaded" && depLoad.status !== "linked"))
            {
                throw $SyntaxError(
                    "module \"" + fullName + "\" was deleted from the loader");
            }

            // Implementation note: unlike the spec, the implementation of
            // GetExports() only bothers to return exports that are not
            // pre-linked by the parser. But in this case we really do need
            // *all* the exports; so we combine the output from GetExports()
            // and $GetModuleExportNames() into a single array.
            starExports = $GetModuleExportNames(depLoad.module);
            if (depLoad.status === "loaded") {
                let moreExports = $MapKeys(GetExports(linkSet, depLoad));
                for (let j = 0; j < moreExports.length; j++)
                    $ArrayPush(starExports, moreExports[j]);
            }
        }

        //>     5. Repeat for each name in starExports,
        for (let j = 0; j < starExports.length; j++) {
            let name = starExports[j];

            // Implementation note: The spec detects this kind of error
            // earlier.  We detect it at the last minute.
            let existingExport = $GetModuleExport(mod, name);
            if ($MapHas(exports, name) ||
                (existingExport !== undefined && $IsExportImplicit(existingExport)))
            {
                throw $SyntaxError(
                    "duplicate export '" + name + "' " +
                    "in module '" + load.fullName + "' " +
                    "due to 'export * from \"" + requestName + "\"'");
            }

            //>         1. If there is not already an edge in exports with the
            //>            [[Name]] name,
            //>             1. Append the new export record {[[ImportModule]]: requestName,
            //>                [[ImportName]]: name, [[ExportName]]: name} to the end of
            //>                the List exports.
            if (existingExport === undefined) {
                $MapSet(exports, name,
                        {importModule: requestName, importName: name, exportName: name});
            }
        }
    }

    //> 8. Set load.[[Exports]] to exports.
    //
    // Implementation note: in the spec, exports is just a List.  This
    // implementation uses a Map for faster lookups by exportName.
    //
    load.exports = exports;

    //> 7. Return exports.
    return exports;
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

//> #### LinkExport(loader, load, edge) Abstract Operation
//>
// Implementation note: My theory is that the spec doesn't need visited because
// all errors are detected in an earlier phase. This implementation uses
// visited to detect cycles.
//
// type of edge is:
// {importModule: string, importName: string, exportName: string}
//
// Implementation note: Returns an opaque "export binding" value, created by
// $GetModuleExport, that can be passed to $LinkPassThroughExport if needed.
//
function LinkExport(loader, load, edge, visited) {
    let mod = $ModuleBodyToModuleObject(load.body);

    // If it is already linked, return the export info.  This will be the case
    // for all local exports, so the rest of the algorithm deals only with
    // pass-through exports.
    let existingExport = $GetModuleExport(mod, edge.exportName);
    if (existingExport !== undefined)
        return existingExport;

    let request = edge.importModule;
    let fullName = $MapGet(load.dependencies, request);
    let origin = ResolveExport(loader, fullName, edge.importName, visited);
    if (origin === undefined) {
        throw $ReferenceError(
            "can't export " + edge.importName + " from '" + request + "': " +
            "no matching export in module '" + fullName + "'");
    }
    $LinkPassThroughExport(mod, edge.exportName, origin);
    return origin;
}

//> #### ResolveExport(loader, fullName, exportName) Abstract Operation
//>
function ResolveExport(loader, fullName, exportName, visited) {
    // If fullName refers to an already-linked Module, return that
    // module's export binding for exportName.
    let loaderData = GetLoaderInternalData(loader);
    let mod = $MapGet(loaderData.modules, fullName);
    if (mod !== undefined)
        return $GetModuleExport(mod, exportName);

    let load = $MapGet(loaderData.loads, fullName);
    if (load === undefined)
        throw $SyntaxError("module \"" + fullName + "\" was deleted from the loader");

    if (load.status === "linked") {
        mod = $ModuleBodyToModuleObject(load.body);
        return $GetModuleExport(mod, exportName);
    }

    // Otherwise, if it refers to a load with .status === "loaded", call
    // LinkExport recursively to resolve the upstream export first.  If not,
    // it's an error.
    if (load.status !== "loaded")
        throw $SyntaxError("module \"" + fullName + "\" was deleted from the loader");

    mod = $ModuleBodyToModuleObject(load.body);
    let exp = $GetModuleExport(mod, exportName);
    if (exp !== undefined)
        return exp;

    // The module `mod` does not have a locally apparent export for
    // `exportName`.  If it does not have an `export * from` for that name
    // either, return undefined.
    let edge = $MapGet(load.exports, exportName);
    if (edge === undefined)
        return undefined;

    // Call LinkExport recursively to link the upstream export.
    for (let i = 0; i < visited.length; i++) {
        if (visited[i] === edge)
            throw $SyntaxError("import cycle detected");
    }
    $ArrayPush(visited, edge);
    exp = LinkExport(loader, load, edge, visited);
    visited.length--;
    return exp;
}

//> #### LinkImport(loader, load, edge) Abstract Operation
//>
function LinkImport(loader, load, edge) {
    let component = TODO_GetComponent(load); // $ModuleBodyToModuleObject(load.body), if module
    let fullName = $MapGet(load.dependencies, edge.importModule);
    let sourceModule = FindModuleForLink(loader, fullName);
    let name = edge.importName;
    if (name === MODULE) {
        $DefineConstant(component, edge.localName, sourceModule);
    } else {
        let exp = $GetModuleExport(module, name);
        if (exp === undefined) {
            throw $ReferenceError("can't import name '" + name + "': " +
                                  "no matching export in module '" + fullName + "'");
        }
        $CreateImportBinding(component, edge.localName, exp);
    }
}

//> #### LinkComponents(linkSet) Abstract Operation
//>
//> Link all scripts and modules in linkSet to each other and to modules in the
//> registry.  This is done in a synchronous walk of the graph.  On success,
//> commit all the modules in linkSet to the loader's module registry.
//>
function LinkComponents(linkSet) {
    let loads = $SetElements(linkSet.loads);

    // Implementation note: This needs error handling. The spec does not,
    // because error-checking is specified to happen in a separate, earlier
    // pass over the components.
    try {
        // Find which names are exported by each new module.
        for (let i = 0; i < loads.length; i++) {
            let load = loads[i];
            $Assert(load.status === "loaded" || load.status === "linked");
            if (load.status === "loaded")
                GetExports(load);
        }

        // Link each export. Implementation note: The primitive that creates
        // the Module instance object from the Module body parse automatically
        // creates export bindings in that Module object for all exports except
        // pass-through exports, so this code only links pass-through exports.
        let loader = linkSet.loader;
        for (let i = 0; i < loads.length; i++) {
            let load = loads[i];
            if (load.status === "loaded" && load.fullName !== null) {
                let edges = $MapValues(load.exports);
                for (let j = 0; j < edges.length; j++) {
                    let edge = edges[j];
                    LinkExport(loader, load, edge, []);
                }
            }
        }

        // Link each import.
        for (let i = 0; i < loads.length; i++) {
            let load = loads[i];
            if (load.status === "loaded") {
                let imports = GetComponentImports(load.linkingInfo);
                for (let j = 0; j < loads.length; j++)
                    LinkImport(loader, load, imports[j]);
            }
        }
    } catch (exc) {
        for (let i = 0; i < loads.length; i++) {
            let load = loads[i];
            if (load.status === "loaded" && load.fullName !== null)
                $UnlinkModule($ModuleBodyToModuleObject(load.body));
        }
        throw exc;
    }

    // Set each linked component's list of dependencies, used by
    // EnsureEvaluated.
    for (let i = 0; i < loads.length; i++) {
        let load = loads[i];
        let deps = [];
        var depNames = $MapValues(load.dependencies);
        for (let j = 0; j < depNames.length; j++)
            $ArrayPush(deps, FindModuleForLink(depNames[j]));
        $SetComponentDependencies(TODO_GetComponent(load), deps);
    }

    // Move the fully linked modules from the `loads` table to the
    // `modules` table.
    for (let i = 0; i < loads.length; i++) {
        let load = loads[i];
        let fullName = load.fullName;
        if (fullName !== null) {
            let m = $ModuleBodyToModuleObject(load.body);
            $MapSet(loaderData.modules, fullName, m);
        }
    }
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

//> #### EvaluateScriptOrModuleOnce(realm, global, c) Abstract Operation
//>
//> Evaluate the given script or module c, but only if we
//> have never tried to evaluate it before.
//>
function EvaluateScriptOrModuleOnce(realm, global, c) {
    let body = $IsModule(c) ? $GetModuleBody(c) : c;
    if (!$WeakMapHas(evaluatedBody, body)) {
        $WeakMapSet(evaluatedBody, body, true);
        return $Evaluate(realm, global, body);
    }
}


//> #### BuildSchedule(c, seen, schedule) Abstract Operation
//>
//> The abstract operation BuildSchedule performs a depth-first walk of the
//> dependency tree of the component c, adding each module to the List
//> schedule. It performs the following steps:
//>
function BuildSchedule(c, seen, schedule) {
    //> 1. Append c as the last element of seen.
    $SetAdd(seen, c);

    //> 2. Let deps be c.[[Dependencies]].
    //
    // (In this implementation, deps is undefined if the module and all its
    // dependencies have been evaluated; or if the module was created via the
    // `Module()` constructor rather than from a script.)
    let deps = $GetComponentDependencies(c);
    if (deps !== undefined) {
        //> 3. Repeat for each dep that is an element of deps, in order
        for (let i = 0; i < deps.length; i++) {
            let dep = deps[i];

            //>         1. If dep is not an element of seen, then
            //>             1. Call BuildSchedule with the arguments dep, seen,
            //>                and schedule.
            if (!$SetHas(seen, dep))
                BuildSchedule(dep, seen, schedule);
        }
    }

    //> 4. Append c as the last element of schedule.
    $SetAdd(schedule, c);
}

//> #### EnsureEvaluated(loader, start) Abstract Operation
//>
//> Walk the dependency graph of the script or module start, evaluating
//> any script or module bodies that have not already been evaluated
//> (including, finally, start itself).
//>
//> Modules are evaluated in depth-first, left-to-right, post order, stopping
//> at cycles.
//>
//> start and its dependencies must already be linked.
//>
//> On success, start and all its dependencies, transitively, will have started
//> to evaluate exactly once.
//>
function EnsureEvaluated(loader, start) {
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

    let loaderData = GetLoaderInternalData(loader);

    //> 1. Let seen be an empty List.
    let seen = $SetNew();

    //> 2. Let schedule be an empty List.
    let schedule = $SetNew();

    //> 3. Call BuildSchedule with arguments start, seen, schedule.
    BuildSchedule(start, seen, schedule);

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

    //> 4. Repeat, for each script or module C in schedule:
    let realm = loaderData.realm;
    let global = loaderData.global;
    let result;
    schedule = $SetElements(schedule);
    for (let i = 0; i < schedule.length; i++) {
        //>     1. Call EvaluateScriptOrModuleOnce with the argument C.
        result = EvaluateScriptOrModuleOnce(realm, global, schedule[i]);
    }

    // All evaluation succeeded. As an optimization for future EnsureEvaluated
    // calls, drop this portion of the dependency graph.  (This loop cannot be
    // fused with the evaluation loop above; the meaning would change on error
    // for certain dependency graphs containing cycles.)
    for (let i = 0; i < schedule.length; i++)
        $SetComponentDependencies(schedule[i], undefined);

    return result;
}


// ## Utility functions

// ES6 ToBoolean abstract operation.
function ToBoolean(v) {
    return !!v;
}

// ES6 ToString abstract operation.
function ToString(v) {
    return "" + v;
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
           typeof v !== "string" &&
           typeof v !== "symbol";
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

})(this);
