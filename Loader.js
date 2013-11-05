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
//     TODO - update this comment `evalAsync`, `load`, and `import`;
//   * a method for compiling modules and putting them into the loader:
//     `define`;
//   * the methods for directly accessing the module map:
//     `get`, `has`, `set`, and `delete`;
//   * the loader hooks and the loading pipeline that calls them;
//   * dependency loading;
//   * linking;
//   * evaluation order;
//   * error handling;
//   * the browser's custom loader hooks: `normalize`, `locate`, `fetch`,
//     `translate`, and `instantiate`.
//
// Some parts are not implemented yet:
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

// * `$ToPromise(thing)` coerces `thing` to a Promise. If `thing` is *not*
//   thenable, this is like Promise.fulfill(thing). Otherwise, this returns a
//   real Promise wrapping `thing`. The real Promise guarantees that it won't
//   call the callbacks multiple times, call both of them, or call them
//   synchronously, no matter what `thing.then()` tries to do.
var std_Promise_isThenable = Promise.isThenable;
var std_Promise_resolve = Promise.resolve;
var std_Promise_fulfill = Promise.fulfill;
var std_Promise_reject = Promise.reject;
function $ToPromise(thing) {
    if (std_Promise_isThenable(thing))
        return std_Promise_resolve(thing);  // BUG - not hardened, need Promise.cast
    else
        return std_Promise_fulfill(thing);
}

// Now on to the core JS language implementation primitives.
//
// * `$ParseModule(loader, src, moduleName, address)` parses the string `src`
//   as an ES6 Module.  `$ParseModule` detects ES "early errors" and throws
//   `SyntaxError` or `ReferenceError`.  On success, it returns either a
//   ModuleBody object.  This is the only way objects of these types are
//   created.  (ModuleBody objects are never exposed to user code; they are for
//   use with the following primitives only.)
//
//   Note that this does not run any of the code in `src`.
//
// The following primitives operate on Module objects.
//
// * `$DefineConstant(module, name, value)` defines a constant binding in
//   the toplevel declarative environment of `module`, with the given `name`
//   and `value`.  This is only used to implement `module a from "A";`
//   declarations, so `value` is always a Module object.
//
// * `$CreateImportBinding(module, name, export)` defines an import binding.
//   `module` is the importing module. `name` is a string, the name of the
//   local binding being bound.  `export` is a value returned by
//   $GetModuleExport(), representing the location of the slot to be bound.
//
//   The effect of `$CreateImportBinding` is that in `module`'s scope,
//   `name` becomes an alias for the binding indicated by `export`.
//
//   `name` must in fact be a name declared by an import declaration in
//   `module`, and it must not already have been bound.
//
// * `$GetDependencies(module)` returns module.[[Dependencies]].  This is
//   either undefined or an array of Module objects, the modules whose bodies
//   are to be evaluated before the given module's body.  A return value of
//   undefined means the same thing as returning an empty array to the sole
//   caller, EnsureEvaluated().
//
// * `$SetDependencies(module, deps)` sets module.[[Dependencies]].
//
// * `$ModuleRequests(body)` - Return an Array of strings, the module
//   specifiers as they appear in import declarations and module declarations
//   in the given module body, with duplicates removed. (This corresponds to
//   the ModuleRequests static semantics operation.)
//
// * `ALL`, `MODULE` - Opaque constants related to `$GetLinkingInfo` (below).
//
// * `$GetLinkingInfo(body)` - Returns an Array of objects representing the
//   import/export/module declarations in the given Module body.
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
var $CreateModule = () => $ObjectCreate(null);

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
// * `$EvaluateModuleBody(realm, mod)` runs the body of the given module in the
//   context of a given realm. Returns undefined.
//
// * `$HasBeenEvaluated(mod)` returns true if mod has ever been passed to
//   $EvaluateModuleBody.
//
// * `$DefineBuiltins(realm, obj)` builds a full copy of the ES builtins on `obj`
//   for the given realm, so for example you get a fresh new `obj.Array`
//   constructor and methods like `obj.Array.prototype.push`. You even get
//   `obj.Loader`, a copy of `Loader`.


// The remaining primitives are not very interesting. These are capabilities
// that JS provides via builtin methods. We use primitives rather than the
// builtin methods because user code can delete or replace the methods.
//
// * `$ObjectCreate(proto)` ~= Object.create(proto)
var $ObjectCreate = Object.create;
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
// * `$PromiseThen(p, fulfill, reject)` ~= p.then(fulfill, reject)
var std_Promise = Promise;
var $PromiseThen = unmethod(Promise.prototype.then);
// * `$TypeError(msg)` ~= new TypeError(msg)
var $TypeError = TypeError;
// * `$SyntaxError(msg)` ~= new SyntaxError(msg)
var $SyntaxError = SyntaxError;


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




//> # Modules: Semantics
//>
//> ## Module Loading
//>


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
// 3.  In all other cases, either a new `Load` is started or we can join one
//     already in flight.  `StartModuleLoad` returns the `Load` object.
//
// `name` is the (pre-normalize) name of the module to be imported, as it
// appears in the import-declaration or as the argument to
// loader.import().
//
// `refererName` and `refererAddress` provide information about the context of
// the `import()` call or import-declaration.  This information is passed to
// all the loader hooks.
//
// TODO:  Suggest alternative name for `referer`.  It is really nothing to
// do with the nasty Referer HTTP header.  Perhaps `importContext`,
// `importer`, `client`.
//
function StartModuleLoad(loader, refererName, refererAddress) {
    var loaderData = GetLoaderInternalData(loader);

    // Call the `normalize` hook to get a normalized module name.  See the
    // comment on `normalize()`.
    //
    // Errors that happen during this step propagate to the caller.
    //
    let normalized = loader.normalize(request, refererName, refererAddress);
    normalized = ToString(normalized);

    // If the module has already been linked, we are done.
    let existingModule = $MapGet(loaderData.modules, normalized);
    if (existingModule !== undefined)
        return {status: "linked", fullName: normalized, module: existingModule};

    // If the module is already loaded, we are done.
    let load = $MapGet(loaderData.loads, normalized);
    if (load !== undefined && load.status === "loaded")
        return load;

    // If the module is already loading, we are done.
    if (load !== undefined) {
        $Assert(load.status === "loading");
        return load;
    }

    return LoadModule(loader, normalized);
}

function LoadModule(loader, normalized) {
    var loaderData = GetLoaderInternalData(loader);
    $Assert(!$MapHas(loaderData.loads, normalized));
    var load = CreateLoad(normalized);
    $MapSet(loaderData.loads, normalized, load);

    var p = new std_Promise(function (resolve, reject) {
        resolve(loader.locate({
            name: load.fullName,
            metadata: load.metadata
        }));
    });
    p = $PromiseThen(p, function (address) {
        if ($SetSize(load.linkSets) === 0)
            return;
        load.address = address;
        return loader.fetch({
            name: load.fullName,
            metadata: load.metadata,
            address: address
        });
    });
    p = $PromiseThen(p, function (source) {
        if ($SetSize(load.linkSets) === 0)
            return;
        return loader.translate({
            name: load.fullName,
            metadata: load.metadata,
            address: load.address,
            source: source
        });
    });
    return CallTranslate(loader, load, p);
}

function CallTranslate(loader, load, p) {
    p = $PromiseThen(p, function (source) {
        if ($SetSize(load.linkSets) === 0)
            return;
        load.source = source;
        return loader.instantiate({
            name: load.fullName,
            metadata: load.metadata,
            address: load.address,
            source: source
        });
    });
    p = $PromiseThen(p, function (result) {
        InstantiateSucceeded(loader, load, result);
    });
    $PromiseThen(p, function (_) {}, function (exc) {
        LoadFailed(load, exc);
    });
    return load;
}

// **`InstantiateSucceeded`** - This is called once the `instantiate` hook
// succeeds. Continue module loading by interpreting the hook's result and
// calling FinishLoad if necessary.
function InstantiateSucceeded(loader, load, instantiateResult) {
    // Interpret `instantiateResult`.  See comment on the `instantiate()`
    // method.
    if (instantiateResult === undefined) {
        let body = $ParseModule(loader, load.source, load.fullName, load.address);
        FinishLoad(load, loader, body);
    } else if (!IsObject(instantiateResult)) {
        throw $TypeError("instantiate hook must return an object or undefined");
    } else if ($IsModule(instantiateResult)) {
        let mod = instantiateResult;
        let name = load.fullName;
        if (name !== undefined) {
            if ($MapHas(loaderData.modules, name)) {
                throw $TypeError("fetched module \"" + name + "\" " +
                                 "but a module with that name is already " +
                                 "in the registry");
            }
            $MapSet(loaderData.modules, name, mod);
        }
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
//  5. Reject the promises associated with each `LinkSet` in F.
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
//   - For each load, we call one or more of the loader hooks.  Getting the
//     hook from the Loader object can trigger a getter that throws.  The value
//     of the hook property can be non-callable.  The hook can throw.  The hook
//     can return an invalid return value.
//
//   - The `normalize`, `locate`, and `instantiate` hooks may return objects
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


//> ### Load Records
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
//>     if they depend on the same module. TODO - update this comment
//>
//>   * load.[[Metadata]] - An object which loader hooks may use for any purpose.
//>     See Loader.prototype.locate.
//>
//>   * load.[[Address]] - The result of the locate hook.
//>
//>   * load.[[Source]] - The result of the translate hook.
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
//         .body is a ModuleBody, or null
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
// The argument fullName is either `undefined` or a normalized module name.
//
function CreateLoad(fullName) {
    return {
        status: "loading",
        fullName: fullName,
        linkSets: $SetNew(),
        metadata: {},
        address: undefined,
        src: undefined,
        body: null,
        linkingInfo: null,
        dependencies: null,
        factory: null,
        exception: null,
        exportedNames: undefined,
        module: null
    };
}

//> #### FinishLoad(load, loader, body) Abstract Operation
//>
// The loader calls this after the last loader hook (the `instantiate` hook),
// and after the module has been parsed. FinishLoad does two things:
//
//   1. Process imports. This may trigger additional loads.
//
//   2. Call LinkSetOnLoad on any listening LinkSets (see that abstract
//      operation for the conclusion of the load/link/evaluate process).
//
// On success, this transitions the `Load` from `"loading"` status to
// `"loaded"`.
//
function FinishLoad(load, loader, body) {
    $Assert(load.status === "loading");
    $Assert($SetSize(load.linkSets) !== 0);

    let refererName = load.fullName;
    let fullNames = [];
    let sets = $SetElements(load.linkSets);

    let moduleRequests = $ModuleRequests(body);

    // For each new dependency, create a new Load Record, if necessary, and add
    // it to the same LinkSet.
    //
    // The module-specifiers in import-declarations are not necessarily
    // normalized module names.  We pass them to StartModuleLoad which will
    // call the `normalize` hook.
    //
    let dependencies = $MapNew();
    for (let i = 0; i < moduleRequests.length; i++) {
        let request = moduleRequests[i];
        let depLoad;
        try {
            depLoad = StartModuleLoad(loader, request, refererName, load.address);
        } catch (exc) {
            return LoadFailed(load, exc);
        }
        $MapSet(dependencies, request, depLoad.fullName);

        if (depLoad.status !== "linked") {
            for (let j = 0; j < sets.length; j++)
                AddLoadToLinkSet(sets[j], depLoad);
        }
    }

    load.status = "loaded";
    load.body = body;
    load.linkingInfo = $GetLinkingInfo(body);
    load.dependencies = dependencies;

    // For determinism, finish linkable LinkSets in timestamp order.
    // (NOTE: If it turns out that Futures fire in deterministic
    // order, then there's no point sorting this array here.)
    $ArraySort(sets, (a, b) => b.timestamp - a.timestamp);
    for (let i = 0; i < sets.length; i++)
        LinkSetOnLoad(sets[i], load);
}

//> #### OnEndRun(load, mod) Abstract Operation
//>
// Called when the `instantiate` hook returns a Module object.
function OnEndRun(load, mod) {
    $Assert(load.status === "loading");
    load.status = "linked";
    load.module = mod;
    $Assert(load.exports === undefined);

    let sets = $SetElements(load.linkSets);
    $ArraySort(sets, (a, b) => b.timestamp - a.timestamp);
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
//> `.load()`, or `.import()`. TODO - update this comment
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

//> #### CreateLinkSet(loader, startingLoad) Abstract Operation
//>
function CreateLinkSet(loader, startingLoad) {
    var loaderData = GetLoaderInternalData(linkSet.loader);
    var resolver;
    var done = new std_Promise(r => { resolver = r; });
    var linkSet = {
        loader: loader,
        done: done,
        resolver: resolver,
        loads: $SetNew(),
        timestamp: loaderData.linkSetCounter++,

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
    // This case can happen in `import`, for example if a `locate` hook
    // throws. TODO - this is probably not true anymore
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
            LinkModules(linkSet);
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
        }
    }

    if (succeeded)
        linkSet.resolver.resolve(undefined);
    else
        linkSet.resolver.reject(exc);
}

// **Timing and grouping of dependencies** - Consider
//
//     loader.evalAsync('module x from "x"; module y from "y";', {}, f);
//
// TODO - update this comment
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



//> ## Module Linking
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


// LinkModules(linkSet) is the entry point to linkage; it implements the
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


//> ### Note: Link-time errors (informative)
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

// **GetModuleImports** - Return an Array that includes one edge for each
// import declaration and each `module ... from` declaration in the given
// module.
function GetModuleImports(linkingInfo) {
    let imports = [];
    for (let i = 0; i < linkingInfo.length; i++) {
        let edge = linkingInfo[i];
        if (edge.importModule !== null && edge.localName !== null)
            $ArrayPush(imports, edge);
    }
    return imports;
}

//> ### GetExports(linkSet, load) Abstract Operation
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

//> ### FindModuleForLink(loader, fullName) Abstract Operation
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

//> ### LinkExport(loader, load, edge) Abstract Operation
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

//> ### ResolveExport(loader, fullName, exportName) Abstract Operation
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

//> ### LinkImport(loader, load, edge) Abstract Operation
//>
function LinkImport(loader, load, edge) {
    let mod = $ModuleBodyToModuleObject(load.body);
    let fullName = $MapGet(load.dependencies, edge.importModule);
    let sourceModule = FindModuleForLink(loader, fullName);
    let name = edge.importName;
    if (name === MODULE) {
        $DefineConstant(mod, edge.localName, sourceModule);
    } else {
        let exp = $GetModuleExport(sourceModule, name);
        if (exp === undefined) {
            throw $ReferenceError("can't import name '" + name + "': " +
                                  "no matching export in module '" + fullName + "'");
        }
        $CreateImportBinding(mod, edge.localName, exp);
    }
}

//> ### LinkModules(linkSet) Abstract Operation
//>
//> Link all scripts and modules in linkSet to each other and to modules in the
//> registry.  This is done in a synchronous walk of the graph.  On success,
//> commit all the modules in linkSet to the loader's module registry.
//>
function LinkModules(linkSet) {
    let loads = $SetElements(linkSet.loads);

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
                let imports = GetModuleImports(load.linkingInfo);
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

    // Set each linked module's list of dependencies, used by
    // EnsureEvaluated.
    for (let i = 0; i < loads.length; i++) {
        let load = loads[i];
        let m = $ModuleBodyToModuleObject(load.body);
        load.module = m;

        let deps = [];
        var depNames = $MapValues(load.dependencies);
        for (let j = 0; j < depNames.length; j++)
            $ArrayPush(deps, FindModuleForLink(depNames[j]));
        $SetDependencies(m, deps);
    }

    // Set the status of Load records for the modules we linked to "linked".
    // Move the fully linked modules from the `loads` table to the `modules`
    // table.
    for (let i = 0; i < loads.length; i++) {
        let load = loads[i];
        let fullName = load.fullName;
        load.status = "linked";
        if (fullName !== undefined)
            $MapSet(loaderData.modules, fullName, load.module);
    }
}



//> ## Module Evaluation
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


//> ### EnsureEvaluated(mod, seen, loader) Abstract Operation
//>
//> The abstract operation EnsureEvaluated walks the dependency graph of the
//> module mod, evaluating any module bodies that have not already been
//> evaluated (including, finally, mod itself).  Modules are evaluated in
//> depth-first, left-to-right, post order, stopping at cycles.
//>
//> mod and its dependencies must already be linked.
//>
//> The List seen is used to detect cycles. mod must not already be in the List
//> seen.
//>
//> On success, mod and all its dependencies, transitively, will have started
//> to evaluate exactly once.
//>
//> EnsureEvaluated performs the following steps:
//>
function EnsureEvaluated(mod, seen, loaderData) {
    // *Why the graph walk doesn't stop at already-evaluated modules:*  It's a
    // matter of correctness.  Here is the test case:
    //
    //     // module "x"
    //     import y from "y";
    //     throw fit;
    //
    //     // module "y"
    //     import x from "x";
    //     global.ok = true;
    //
    //     // anonymous module #1
    //     module y from "y";  // marks "x" as evaluated, but not "y"
    //
    //     // anonymous module #2
    //     module x from "x";  // must evaluate "y" but not "x"
    //
    // When we `EnsureEvaluated` anonymous module #2, module `x` is already
    // marked as evaluated, but one of its dependencies, `y`, isn't.  In order
    // to achieve the desired postcondition, we must find `y` anyway and
    // evaluate it.
    //
    // Cyclic imports, combined with exceptions during module evaluation
    // interrupting this algorithm, are the culprit.
    //
    // The remedy: when walking the dependency graph, do not stop at
    // already-marked-evaluated modules.
    //
    // (This implementation optimizes away future EnsureEvaluated passes by
    // clearing mod.[[Dependencies]] for all modules in the dependency tree
    // when EnsureEvaluated finishes successfully.)

    //> 1. Append mod as the last element of seen.
    $SetAdd(seen, mod);

    //> 2. Let deps be mod.[[Dependencies]].
    //
    // (In this implementation, deps is undefined if the module and all its
    // dependencies have been evaluated; or if the module was created via the
    // `Module()` constructor rather than from a script.)
    let deps = $GetDependencies(mod);
    if (deps !== undefined) {
        //> 3. Repeat for each dep that is an element of deps, in order
        for (let i = 0; i < deps.length; i++) {
            let dep = deps[i];

            //>         1. If dep is not an element of seen, then
            //>             1. Call BuildSchedule with the arguments dep, seen,
            //>                and schedule.
            if (!$SetHas(seen, dep))
                EnsureEvaluated(dep, seen, loaderData);
        }
    }

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

    //> 4. If mod.[[Evaluated]] is false,
    if (!$HasBeenEvaluated(mod)) {
        //>     1. Set mod.[[Evaluated]] to true.
        //>     2. Let initContext be a new ECMAScript code execution context.
        //>     3. Set initContext's Realm to loader.[[Realm]].
        //>     4. Set initContext's VariableEnvironment to mod.[[Environment]].
        //>     5. Set initContext's LexicalEnvironment to mod.[[Environment]].
        //>     6. If there is a currently running execution context, suspend it.
        //>     7. Push initContext on to the execution context stack; initContext is
        //>         now the running execution context.
        //>     8. Let r be the result of evaluating mod.[[Body]].
        //>     9. Suspend initContext and remove it from the execution context stack.
        //>     10. Resume the context, if any, that is now on the top of the execution
        //>         context stack as the running execution context.
        //>     11. ReturnIfAbrupt(r).
        $EvaluateModuleBody(loaderData.realm, mod);
    }
}

function EnsureEvaluatedHelper(mod, loader) {
    let seen = $SetNew();
    let loaderData = GetLoaderInternalData(loader);
    EnsureEvaluated(mod, seen, loaderData);

    // All evaluation succeeded. As an optimization for future EnsureEvaluated
    // calls, drop this portion of the dependency graph.  (This loop cannot be
    // fused with the evaluation loop above; the meaning would change on error
    // for certain dependency graphs containing cycles.)
    seen = $SetElements(seen);
    for (let i = 0; i < seen.length; i++)
        $SetDependencies(seen[i], undefined);
}




//> # Modules: Built-in objects
//>
//> ## Module objects
//>
//> Module instances are ordinary objects.
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
//   * has a [[Dependencies]] internal data property, a List of Modules or
//     undefined.  This is populated at link time by the loader and used by
//     EnsureEvaluated.
//
//   * has accessor properties that correspond exactly to the [[Exports]], and no
//     other properties.
//
//   * is inextensible by the time it is exposed to ECMAScript code.

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
//   * `normalize(name, refererName, refererAddress)` - From a possibly
//     relative module name, determine the full module name.
//
//   * `locate(fullName, metadata)` - Given a full module name, determine
//     the address to load.
//
//   * `fetch(address, metadata)` - Load a module from the given address.
//
//   * `translate(src, metadata)` - Optionally translate a module from some
//     other language to JS.
//
//   * `instantiate(src, metadata)` - Optionally convert an AMD/npm/other module
//     to an ES Module object.



//> ### The Loader Constructor
//>
//> #### Loader ( options )
//>

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

//> When the `Loader` function is called with optional argument options the
//> following steps are taken:
//>
function Loader(options={}) {
    //> 1.  Let loader be the this value.
    //> 2.  If Type(loader) is not Object, throw a TypeError exception.
    //
    // Bug: This calls Loader[@@create] directly.  The spec will instead make
    // `new Loader(options)` equivalent to
    // `Loader.[[Call]](Loader[@@create](), List [options])`.
    // In other words, Loader[@@create] will be called *before* Loader.
    // We'll change that when symbols and @@create are implemented.
    var loader = callFunction(Loader["@@create"], Loader);

    //> 3.  If loader does not have all of the internal properties of a Module
    //>     Instance, throw a TypeError exception.
    var loaderData = $WeakMapGet(loaderInternalDataMap, loader);
    if (loaderData === undefined)
        throw $TypeError("Loader object expected");

    //> 4.  If loader.[[Modules]] is not undefined, throw a TypeError
    //>     exception.
    if (loaderData.modules !== undefined)
        throw $TypeError("Loader object cannot be intitialized more than once");

    //> 5.  If Type(options) is not Object, throw a TypeError exception.
    if (!IsObject(options))
        throw $TypeError("options must be an object or undefined");

    // Fallible operations.

    //> 6.  Let realmOption be the result of calling the [[Get]] internal method
    //>     of options with arguments `"realm"` and options.
    //> 7.  ReturnIfAbrupt(realmOption).
    var realmOption = options.realm;

    let realm;
    //> 8.  If realmOption is undefined,
    if (realmOption === undefined) {
        //>     1.  Let realm to the result of CreateRealm().
        realm = $CreateRealm();
    //> 9.  Else if Type(realmOption) is Object and realmOption has all the
    //>     internal properties of a Loader instance,
    } else if (IsObject(realmOption) && $WeakMapHas(loaderInternalDataMap, realmOption)) {
        //>     1. Let realm be realmOption.[[Realm]].
        let realmLoaderData = $WeakMapGet(loaderInternalDataMap, realmOption);
        realm = realmLoaderData.realm;
    //> 10. Else,
    } else {
        //>     1.  Let realmDesc be ObjectToRealmDescriptor(realmOption).
        //>     2.  ReturnIfAbrupt(realmDesc);
        //>     3.  Let realm be the result of CreateRealm(realmDesc).
        throw TODO;
    }

    //> 11. Let builtins be the result of performing ObjectCreate(%ObjectPrototype%).
    var builtins = {};
    //> 12. Call DefineBuiltins(realm, builtins).
    $DefineBuiltins(loaderData.realm, builtins);
    //> 13. Let result be the result of calling the [[DefineOwnProperty]]
    //>     internal method of loader passing `"builtins`" and the Property
    //>     Descriptor {[[Value]]: builtins, [[Writable]]: true,
    //>     [[Enumerable]]: true, [[Configurable]]: true} as arguments.
    //> 14. ReturnIfAbrupt(13).
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
    //> 15. For each name in the List (`"normalize"`, `"locate"`, `"fetch"`,
    //>     `"translate"`, `"instantiate"`),
    let hooks = ["normalize", "locate", "fetch", "translate", "instantiate"];
    for (let i = 0; i < hooks.length; i++) {
        let name = hooks[i];
        //     1.  Let hook be the result of calling the [[Get]] internal
        //         method of options with arguments name and options.
        //     2.  ReturnIfAbrupt(hook).
        var hook = options[name];
        //     3.  If hook is not undefined,
        if (hook !== undefined) {
            //         1.  Let result be the result of calling the
            //             [[DefineOwnProperty]] internal method of loader
            //             passing name and the Property Descriptor {[[Value]]:
            //             hook, [[Writable]]: true, [[Enumerable]]: true,
            //             [[Configurable]]: true} as arguments.
            $ObjectDefineProperty(loader, name, {
                configurable: true,
                enumerable: true,
                value: hook,
                writable: true
            });
        }
    }

    // Infallible initialization of internal data properties.
    //> 16. Set loader.[[Modules]] to a new empty List.
    loaderData.modules = $MapNew();
    //> 17. Set loader.[[Loads]] to a new empty List.
    loaderData.loads = $MapNew();
    //> 18. Set loader.[[Realm]] to realm.
    loaderData.realm = realm;

    //> 19. Return loader.
    return loader;
}

// Define properties on an object. The properties defined this way are exactly
// like the originals on *props*, but non-enumerable. This is used to build
// prototype objects and to attach Module and Loader to the global.
function def(obj, props) {
    // This helper function calls Object methods directly because it is only
    // called during polyfill initialization, and then never again. In all
    // other places where standard library features are used, we make an effort
    // to be robust against mutation of the built-in objects.
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
//> The @@create method of the builtin Loader constructor performs the
//> following steps:
//>
function create() {
    //> 1.  Let F be the this value.
    //> 2.  Let loader be the result of calling
    //>     OrdinaryCreateFromConstructor(F, "%LoaderPrototype%", ([[Modules]],
    //>     [[Loads]], [[Realm]])).
    var loader = $ObjectCreate(this.prototype);

    // The fields are initially undefined but are populated when the
    // constructor runs.
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
        modules: undefined,

        // **`loaderData.loads`** stores information about modules that are
        // loading or loaded but not yet committed to the module registry.
        // It maps full module names to Load records.
        //
        // This is stored in the loader so that multiple calls to
        // `loader.load()/.import()/.evalAsync()` can cooperate to fetch
        // what they need only once. TODO - update this comment
        //
        loads: undefined,

        // **`loaderData.realm`** is an ECMAScript Realm. It determines the
        // global scope and intrinsics of all code this Loader runs. By
        // default, `new Loader()` creates a new Realm.
        realm: undefined,

        // **`loaderData.linkSetCounter`** is used to give each LinkSet record
        // an id (LinkSet.timestamp) that imposes a total ordering on
        // LinkSets. This is used when multiple LinkSets are completed or
        // rejected at once (FinishLoad, RejectLoad).  This counter is an
        // implementation detail; the spec just says "in the order in which
        // they were created".
        linkSetCounter: 0
    };
    $WeakMapSet(loaderInternalDataMap, loader, internalData);

    //> 3.  Return loader.
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


// **`UnpackOption`** - Used by several Loader methods to get options
// off of an options object and, if defined, coerce them to strings.
//
// TODO - update this comment
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

def(Loader.prototype, {

    //> #### Loader.prototype.global
    //>
    //> `Loader.prototype.global` is an accessor property whose set accessor
    //> function is undefined. Its get accessor function performs the following
    //> steps:
    //>
    get global() {
        //> 1. Let L be this Loader.
        //> 2. Return L.[[Realm]].[[globalThis]].
        return GetLoaderInternalData(this).realm.global;
    },
    //>


    // ### Loading and running code
    //
    // The high-level interface of `Loader` consists of a few methods for
    // loading and running code.
    //
    // These are implemented in terms of slightly lower-level building blocks.
    // Each of these methods creates a `LinkSet` object, which is in charge
    // of linking, and at least one `Load`.


    //> #### Loader.prototype.module ( source )
    //>
    // **`module`** - Execute a top-level, anonymous module, without adding it
    // to the loader's module registry.
    //
    // This is the dynamic equivalent of an asynchronous, anonymous `<module>`
    // in HTML.
    //
    // Returns a future for the Module object.
    //
    module: function module_(source) {
        var loader = this;
        GetLoaderInternalData(loader);
        source = ToString(source);

        return new std_Promise(function (resolve, reject) {
            let address = UnpackOption(options, "address");
            let load = CreateLoad(undefined);
            $PromiseThen(CreateLinkSet(loader, load).done,
                         _ => resolve(load.module),
                         reject);
            var sourcePromise = Promise.fulfill(source);
            CallTranslate(loader, load, sourcePromise);
        });
    },
    //>
    //> The `length` property of the `module` method is **2**.
    //>


    //> #### Loader.prototype.import ( moduleName, options )
    //>

    // **`import`** - Asynchronously load, link, and evaluate a module and any
    // dependencies it imports.  Return a promise for the `Module` object.
    //
    import: function import_(moduleName,
                             options = undefined)
    {
        var loader = this;

        return new std_Promise(function (resolver) {
            // Unpack `options`.  (Implementation note: if a Promise's init
            // function throws, the new Promise is automatically
            // rejected. UnpackOption and StartModuleLoad can throw.)

            let name = UnpackOption(options, "module");
            let address = UnpackOption(options, "address");

            // `StartModuleLoad` starts us along the pipeline.
            let load = StartModuleLoad(loader, moduleName, name, address);

            if (load.status === "linked") {
                // We already had this module in the registry.
                resolver.resolve(load.module);
            } else {
                // The module is now loading.  When it loads, it may have more
                // imports, requiring further loads, so put it in a LinkSet.
                $PromiseThen(CreateLinkSet(loader, load).done,
                             success,
                             exc => resolver.reject(exc));
            }

            function success() {
                $Assert(load.status === "linked");
                let m = load.module;
                try {
                    if (m === undefined) {
                        throw $TypeError("import(): module \"" + load.fullName +
                                         "\" was deleted from the loader");
                    }
                    EnsureEvaluatedHelper(m, loader);
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


    //> #### Loader.prototype.define ( name, source, options = undefined )
    //>
    define: function define(name, source, options=undefined) {
        let loader = this;
        let loaderData = GetLoaderInternalData(this);
        name = ToString(name);
        let address = undefined;
        let metadata = undefined;
        if (options !== undefined) {
            options = ToObject(options);
            address = options.address;
            metadata = options.metadata;
        }
        if (metadata === undefined)
            metadata = {};

        return new std_Promise(function (resolve, reject) {
            // Make a LinkSet.  Pre-populate it with a Load object for the
            // given module.  Start the Load process at the `translate` hook.
            let load = CreateLoad(name);
            let linkSet = CreateLinkSet(loader, load);
            $MapSet(loaderData.loads, fullName, load);
            $PromiseThen(linkSet.done,
                         _ => resolve(undefined),
                         reject);
            let sourcePromise = std_Promise_fulfill(source);
            CallTranslate(loader, load, sourcePromise);
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

        return new std_Promise(function (resolver) {
            let name, address;
            try {
                name = UnpackOption(options, "module");
                address = UnpackOption(options, "address");
            } catch (exn) {
                resolver.resolve(exn);
                return;
            }

            // Make a LinkSet.
            let linkSet = undefined;
            for (let i = 0; i < names.length; i++) {
                let moduleName = names[i];
                let load = StartModuleLoad(loader, moduleName, name, address);
                if (linkSet === undefined) {
                    linkSet = CreateLinkSet(loader, load);
                    $PromiseThen(linkSet.done,
                                 _ => resolver.resolve(undefined),
                                 exc => resolver.reject(exc));
                } else {
                    AddLoadToLinkSet(linkSet, load);
                }
            }
        });
    },


    // ### Module registry
    //
    // Each `Loader` has a **module registry**, a cache of already loaded and
    // linked modules.  The Loader uses this map to avoid fetching modules
    // multiple times.
    //
    // The methods below support directly querying and modifying the registry.
    // They are synchronous and never fire any loader hooks or trigger new
    // loads.
    //
    // The polyfill for these methods ends up being shorter than the
    // specification text because they use Maps internally. Perhaps the
    // spec will gain a few abstractions for &ldquo;association Lists&rdquo;,
    // but there&rsquo;s nothing at the moment.
    //

    //> #### Loader.prototype.get ( name )
    //>
    //> If this Loader's module registry contains a Module with the given
    //> normalized name, return it.  Otherwise, return undefined.
    //>
    //> If the module is in the registry but has never been evaluated, first
    //> synchronously evaluate the bodies of the module and any dependencies
    //> that have not evaluated yet.
    //>
    //> When the `get` method is called with one argument, the following steps
    //> are taken:
    //>
    get: function get(name) {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);

        //> 3.  Let name be ToString(name).
        //> 4.  ReturnIfAbrupt(name).
        name = $ToString(name);

        //> 5.  Repeat for each Record {[[key]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name, then
        //>         1.  Let module be p.[[value]].
        //>         2.  Let result be the result of EnsureEvaluated(module, (),
        //>             loader).
        //>         3.  ReturnIfAbrupt(result).
        //>         4.  Return p.[[value]].
        //> 6.  Return undefined.
        let m = $MapGet(loaderData.modules, ToString(name));
        if (m !== undefined)
            EnsureEvaluatedHelper(m, this);
        return m;
    },
    //>


    //> #### Loader.prototype.has ( name )
    //>
    //> Return true if this Loader's module registry contains a Module with the
    //> given name. This method does not call any hooks or run any module code.
    //>
    //> The following steps are taken:
    //>
    has: function has(name) {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);

        //> 3.  Let name be ToString(name).
        //> 4.  ReturnIfAbrupt(name).
        name = $ToString(name);

        //> 5.  Repeat for each Record {[[name]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name, then return true.
        //> 6.  Return false.
        return $MapHas(loaderData.modules, ToString(name));
    },
    //>


    //> #### Loader.prototype.set ( name, module )
    //>
    //> Store a module in this Loader's module registry, overwriting any existing
    //> entry with the same name.
    //>
    //> The following steps are taken:
    //>
    set: function set(name, module) {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);

        //> 3.  Let name be ToString(name).
        //> 4.  ReturnIfAbrupt(name).
        name = ToString(name);

        //> 5.  If module does not have all the internal data properties of a
        //>     Module instance, throw a TypeError exception.
        if (!$IsModule(module))
            throw $TypeError("Module object required");

        //> 6.  Repeat for each Record {[[name]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name,
        //>         1.  Set p.[[value]] to module.
        //>         2.  Return loader.
        //> 7.  Let p be the Record {[[key]]: name, [[value]]: module}.
        //> 8.  Append p as the last record of loader.[[Modules]].
        //> 9.  Return loader.
        $MapSet(loaderData.modules, name, module);
        return this;
    },
    //>
    //
    // **The `Module` type check in `.set()`:** If the module argument is not
    // actually a `Module`, `set` fails. This enforces an invariant of the
    // module registry: all the values are `Module` instances. *Rationale:* We
    // use `Module`-specific intrinsics on them, particularly
    // `$GetModuleExport`.
    //
    // **`.set()` and already-linked modules:** If there is already a module in
    // the registry with the given full name, `set` replaces it, but any
    // scripts or modules that are linked to the old module remain linked to
    // it. *Rationale:* Re-linking already-linked modules might not work, since
    // the new module may export a different set of names. Also, the new module
    // may be linked to the old one! This is a convenient way to monkeypatch
    // modules. Once modules are widespread, this technique can be used for
    // polyfilling.
    //
    // **`.set()` and concurrent loads:** If a Load Record for `name` is in
    // `this.loads`, `.set()` succeeds, with no immediate effect on the pending
    // load; but if that load is eventually linked, an error will occur at the
    // end of the link phase, just before any of the new linked modules are
    // committed to the registry.


    //> #### Loader.prototype.delete ( name )
    //>
    //> Remove an entry from this loader's module registry.
    //>
    //> The following steps are taken:
    //>
    delete: function delete_(name) {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);

        //> 3.  Let name be ToString(name).
        //> 4.  ReturnIfAbrupt(name).
        name = ToString(name);

        //> 5.  Repeat for each Record {[[name]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name,
        //>         1.  Set p.[[key]] to empty.
        //>         2.  Set p.[[value]] to empty.
        //>         3.  Return true.
        //> 6.  Return false.
        //
        // If there is no module with the given name in the registry, this does
        // nothing.
        //
        // `loader.delete("A")` has no effect at all if
        // `!loaderData.modules.has("A")`, even if "A" is currently loading (an
        // entry exists in `loaderData.loads`).  This is analogous to `.set()`.
        //
        return $MapDelete(loaderData.modules, name);
    },
    //>
    //
    // **`.delete()` and concurrent loads:** Calling `.delete()` has no
    // immediate effect on in-flight loads, but it can cause such a load to
    // fail later.
    //
    // That's because the dependency-loading algorithm (above) assumes that if
    // it finds a module in the registry, it doesn't need to load that module.
    // If someone deletes that module from the registry (and doesn't replace it
    // with something compatible), then when loading finishes, it will find
    // that a module it was counting on has vanished.  Linking will fail.
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


    //> #### Loader.prototype.entries ( )
    //>
    //> The following steps are taken.
    //>
    entries: function entries() {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);
        //> 3.  Return the result of CreateLoaderIterator(loader, `"key+value"`).
        return new LoaderIterator($MapEntriesIterator(loaderData.modules));
    },
    //>


    //> #### Loader.prototype.keys ( )
    //>
    //> The following steps are taken.
    //>
    keys: function keys() {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);
        //> 3.  Return the result of CreateLoaderIterator(loader, `"key"`).
        return new LoaderIterator($MapKeysIterator(loaderData.modules));
    },
    //>


    //> #### Loader.prototype.values ( )
    //>
    //> The following steps are taken.
    //>
    values: function values() {
        //> 1.  Let loader be this Loader.
        //> 2.  ReturnIfAbrupt(loader).
        let loaderData = GetLoaderInternalData(this);
        //> 3.  Return the result of CreateLoaderIterator(loader, `"value"`).
        return new LoaderIterator($MapValuesIterator(loaderData.modules));
    },


    // ### Loader hooks
    //
    // These five methods may be overloaded in a subclass or in any particular
    // Loader instance. Together, they govern the process of loading a single
    // module. (There are no hooks into the link phase or the module registry
    // itself.)
    //

    //> #### Loader.prototype.normalize ( name, refererName, refererAddress )
    //>
    //> This hook receives the module name as written in the import
    //> declaration.  It returns a string, the full module name, which is used
    //> for the rest of the import process.  In particular, loader.[[Loads]]
    //> and loader.[[Modules]] are both keyed by normalized module names.  Only
    //> a single load can be in progress for a given normalized module name at
    //> a time.  The module registry can contain at most one module for a gievn
    //> module name.)
    //>
    //> *When this hook is called:*  When a module body is parsed, once per
    //> distinct module specifier in that module body.
    //>
    //> After calling this hook, if the full module name is in the registry or
    //> the load table, no new Load Record is created. Otherwise the loader
    //> kicks off a new Load, starting by calling the `locate` hook.
    //>
    //> *Default behavior:*  Return the module name unchanged.
    //>
    //> When the normalize method is called, the following steps are taken:
    //>
    normalize: function normalize(name, refererName, refererAddress) {
        //> 1. Return name.
        return name;
    },
    //>


    //> #### Loader.prototype.locate ( load )
    //>
    //> Given a normalized module name, determine the resource address (URL,
    //> path, etc.) to load.
    //>
    //> The loader passes an argument, load, which is an ordinary Object with
    //> two own properties. `load.name` is the normalized name of the module to
    //> be located.  `load.metadata` is a new Object which the hook may use for
    //> any purpose. The Loader does not use this Object except to pass it to
    //> the subsequent loader hooks.
    //>
    //> The hook returns either the resource address (any non-thenable value)
    //> or a thenable for the resource address. If the hook returns a thenable,
    //> loading will continue with the `fetch()` hook once the promise is
    //> fulfilled.
    //>
    //> *When this hook is called:*  For all imports, immediately after the
    //> `normalize` hook returns successfully, unless the module is already
    //> loaded or loading.
    //>
    //> *Default behavior:*  Return the module name unchanged.
    //>
    //> NOTE The browser's `System.locate` hook may be considerably more
    //> complex.
    //>
    //> When the locate method is called, the following steps are taken:
    //>
    locate: function locate(load) {
        //> 1. Return the result of calling the [[Get]] internal method of load
        //>    passing `"name"` and load as the arguments.
        return load.name;
    },
    //>


    //> #### Loader.prototype.fetch ( load )
    //>
    //> Fetch the requested source from the given address (produced by the
    //> `locate` hook).
    //>
    //> This is the hook that must be overloaded in order to make the `import`
    //> keyword work.
    //>
    //> The loader passes an argument, load, which is an ordinary Object with
    //> three own properties. `load.name` and `load.metadata` are the same
    //> values passed to the `locate` hook. `load.address` is the address of
    //> the resource to fetch. (This is the value produced by the `locate`
    //> hook.)
    //>
    //> The fetch hook returns either module source (any non-thenable value) or
    //> a thenable for module source.
    //>
    //> *When this hook is called:* For all modules whose source is not
    //> directly provided by the caller.  It is not called for the module
    //> bodies provided as arguments to `loader.module()` or `loader.define()`,
    //> since those do not need to be fetched. (However, this hook may be
    //> called when loading dependencies of such modules.)
    //>
    //> *Default behavior:*  Throw a `TypeError`.
    //>
    //> When the fetch method is called, the following steps are taken:
    //>
    fetch: function fetch(load) {
        //> 1. Throw a TypeError exception.
        throw $TypeError("Loader.prototype.fetch was called");
    },
    //>


    //> #### Loader.prototype.translate ( load )
    //>
    //> Optionally translate the given source from some other language into
    //> ECMAScript.
    //>
    //> The loader passes an argument, load, which is an ordinary Object with
    //> four own properties. `load.name`, `load.metadata`, and `load.address`
    //> are the same values passed to the `fetch` hook. `load.source` is the
    //> source code to be translated. (This is the value produced by the
    //> `fetch` hook.)
    //>
    //> The hook returns either an ECMAScript ModuleBody (any non-Promise
    //> value) or a thenable for a ModuleBody.
    //>
    //> *When this hook is called:* For all modules, including module bodies
    //> passed to `loader.module()` or `loader.define()`.
    //>
    //> *Default behavior:*  Return the source unchanged.
    //>
    //> When the translate method is called, the following steps are taken:
    //>
    translate: function translate(load) {
        //> 1. Return the result of calling the [[Get]] internal method of load
        //>    passing `"source"` and load as the arguments.
        return load.source;
    },
    //>


    //> #### Loader.prototype.instantiate ( load )
    //>
    //> Allow a loader to optionally provide interoperability with other module
    //> systems.
    //>
    //> The loader passes an argument, load, which is an ordinary Object with
    //> four own properties. `load.name`, `load.metadata`, and `load.address`
    //> are the same values passed to the `fetch` and `translate` hooks.
    //> `load.source` is the translated module source. (This is the value
    //> produced by the `translate` hook.)
    //>
    //> There are three options.
    //>
    //>  1. The instantiate hook may return `undefined`. The loader then uses
    //>     the default linking behavior.  It parses src as a module body,
    //>     looks at its imports, loads all dependencies asynchronously, and
    //>     finally links them as a unit and adds them to the registry.
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
    instantiate: function instantiate(load) {
        //> 1. Return **undefined**.
    }
    //>
});


//> #### Loader.prototype[@@iterator] ( )
//>
//> The initial value of the @@iterator property is the same function
//> object as the initial value of the entries property.
def(Loader.prototype, {"@@iterator": Loader.prototype.entries});


//> ### Loader Iterator Object Structure
//>
//> A Loader Iterator is an object, with the structure defined below, that
//> represents a specific iteration over the module registry of some specific
//> Loader instance object.
//>

//> #### CreateLoaderIterator(loader, kind) Abstract Operation
//>
//> Several methods of Loader objects return LoaderIterator objects. The
//> abstract iteration CreateLoaderIterator is used to create such iterator
//> objects. It performs the following steps:
//>
//> 1.  Assert: Type(loader) is Object.
//> 2.  Assert: loader has all the internal data properties of a Loader object.
//> 3.  Let iterator be the result of ObjectCreate(%LoaderIteatorPrototype%,
//>     ([[Loader]], [[ModuleMapNextIndex]], [[MapIterationKind]])).
//> 4.  Set iterator.[[Loader]] to loader.
//> 5.  Set iterator.[[ModuleMapNextIndex]] to 0.
//> 6.  Set iterator.[[MapIterationKind]] to kind.
//> 7.  Return iterator.
//>
function LoaderIterator(iterator) {
    $SetLoaderIteratorPrivate(this, iterator);
}

//> #### The Loader Iterator Prototype
//>
//> All Loader Iterator Objects inherit properties from a common Loader
//> Iterator Prototype object.  The [[Prototype]] internal data property of the
//> Loader Iterator Prototype is the %ObjectPrototype% intrinsic object. In
//> addition, the Loader Iterator Prototype has the following properties:
//>

def(LoaderIterator.prototype, {
    //> ##### *LoaderIteratorPrototype*.constructor
    //>

    //> ##### *LoaderIteratorPrototype*.next ( )
    //>
    //> 1.  Let O be the this value.
    //> 2.  If Type(O) is not Object, throw a TypeError exception.
    //> 3.  If O does not have all of the internal properties of a Loader
    //>     Iterator Instance, throw a TypeError exception.
    //> 4.  Let loader be the value of the [[Loader]] internal data property of
    //>     O.
    //> 5.  Let index be the value of the [[ModuleMapNextIndex]] internal data
    //>     property of O.
    //> 6.  Let itemKind be the value of the [[MapIterationKind]] internal data
    //>     property of O.
    //> 7.  Assert: loader has a [[Modules]] internal data property and loader
    //>     has been initialised so the value of loader.[[Modules]] is not
    //>     undefined.
    //> 8.  Repeat while index is less than the total number of elements of
    //>     loader.[[Modules]],
    //>     1.  Let e be the Record {[[key]], [[value]]} at 0-origined
    //>         insertion position index of loader.[[Modules]].
    //>     2.  Set index to index + 1.
    //>     3.  Set the [[ModuleMapNextIndex]] internal data property of O to
    //>         index.
    //>     4.  If e.[[key]] is not empty, then
    //>         1.  If itemKind is `"key"`, then let result be e.[[key]].
    //>         2.  Else if itemKind is `"value"`, then let result be
    //>             e.[[value]].
    //>         3.  Else,
    //>             1.  Assert: itemKind is `"key+value"`.
    //>             2.  Let result be the result of ArrayCreate(2).
    //>             3.  Assert: result is a new, well-formed Array object so
    //>                 the following operations will never fail.
    //>             4.  Call CreateOwnDataProperty(result, `"0"`, e.[[key]]).
    //>             5.  Call CreateOwnDataProperty(result, `"1"`, e.[[value]]).
    //>         4.  Return CreateIterResultObject(result, false).
    //> 9.  Return CreateIterResultObject(undefined, true).
    //>
    // The implementation is one line of code, delegating to
    // MapIterator.prototype.next.
    //
    next: function next() {
        return $MapIteratorNext($GetLoaderIteratorPrivate(this));
    },

    //> ##### *LoaderIteratorPrototype* [ @@iterator ] ()
    //>
    //> The following steps are taken:
    //>
    // Bug: "@@iterator" should of course be [Symbol.iterator], but
    // SpiderMonkey doesn't have Symbol support yet.
    //
    "@@iterator": function () {
        //> 1.  Return the this value.
        return this;
    },
    //>

    //> ##### *LoaderIteratorPrototype* [ @@toStringTag ]
    //>
    //> The initial value of the @@toStringTag property is the string value
    //> `"Loader Iterator"`.
    //>
    "@@toStringTag": "Loader Iterator"
});


})(this);
