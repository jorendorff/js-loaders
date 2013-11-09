// # Loader.js - ES6 module loaders illustrated
//
// This is a sample implementation of the ES6 module loader.  The code is
// interleaved with comments containing draft specification language for the
// ES6 module system.
//
// Source code is on github:
// [jorendorff/js-loaders](https://github.com/jorendorff/js-loaders).


// ## Current status
//
// This code does not work yet. We're focusing on producing a coherent spec
// document. I'm also very interested in standing the system up and running
// tests, but that will have to wait a week or two.


// ## Prelude
//
// This implementation uses some ES builtins. User scripts may mutate or delete
// those builtins, so we capture everything we need up front.
//
(function (global) {
"use strict";

var std_Function_call = Function.prototype.call;
var std_Function_bind = Function.prototype.bind;
var bind = std_Function_call.bind(std_Function_bind);
var callFunction = bind(std_Function_call, std_Function_call);

var std_Object_create = Object.create;
var std_Object_defineProperty = Object.defineProperty;
var std_Object_keys = Object.keys;
var std_Object_preventExtensions = Object.preventExtensions;
var std_Array_push = Array.prototype.push;
var std_Array_sort = Array.prototype.sort;
var std_Set = Set;
var std_Set_get_size = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
var std_Set_has = Set.prototype.has;
var std_Set_add = Set.prototype.add;
var std_Set_delete = Set.prototype.delete;
var std_Set_iterator = Set.prototype["@@iterator"];
var std_Set_iterator_next = new Set()["@@iterator"]().next;
var std_Map = Map;
var std_Map_has = Map.prototype.has;
var std_Map_get = Map.prototype.get;
var std_Map_set = Map.prototype.set;
var std_Map_delete = Map.prototype.delete;
var std_Map_entries = Map.prototype.entries;
var std_Map_keys = Map.prototype.keys;
var std_Map_values = Map.prototype.values;
var std_Map_iterator_next = new Map().keys().next;
var std_WeakMap = WeakMap;
var std_WeakMap_has = WeakMap.prototype.has;
var std_WeakMap_get = WeakMap.prototype.get;
var std_WeakMap_set = WeakMap.prototype.set;
var std_Promise = Promise;
var std_Promise_all = Promise.all;
var std_Promise_fulfill = Promise.fulfill;
var std_Promise_then = Promise.prototype.then;
var std_Promise_catch = Promise.prototype.catch;
var std_TypeError = TypeError;


// A handful of utility functions built from ES standard facilities.

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

// ES6 IsCallable abstract operation.
//
// This is technically correct according to the table in the defintion of the
// ES6 `typeof` operator, although some JavaScript engines return `"object"` as
// the type of some objects that implement [[Call]].
//
function IsCallable(v) {
    return typeof v === "function";
}

// This implementation uses ES6 Set, Map, and WeakMap objects in some places
// where the spec text refers to Lists and internal data properties.
//
// Bug: In implementations that support @@create, the `CreateSet()` function
// given here would be affected by modifying the @@create method of the Set
// builtin (which is a configurable property). This implementation will change
// whenever @@create is implemented. The same is true for `CreateMap()` and
// `CreateWeakMap()`.
//
function CreateSet() {
    return new std_Set;
}

function CreateMap() {
    return new std_Map;
}

function CreateWeakMap() {
    return new std_WeakMap;
}

function IteratorToArray(iter, next) {
    var a = [];
    for (var x = callFunction(next, iter); !x.done; x = callFunction(next, iter))
        callFunction(std_Array_push, a, x.value);
    return a;
}

function SetToArray(set) {
    return IteratorToArray(callFunction(std_Set_iterator, set));
}

function MapValuesToArray(map) {
    return IteratorToArray(callFunction(std_Map_values, map), std_Map_iterator_next);
}

// `Assert(condition)` is your bog-standard assert function. In theory, it
// does nothing. The given `condition` is always true.
function Assert(condition) {
    if (typeof assert === "function")
        assert(condition);
    else if (typeof assertEq === "function")
        assertEq(condition, true);

    if (condition !== true)
        throw "assertion failed";
}


// ## Primitives
//
// We rely on the JavaScript implementation to provide a few primitives.  You
// can skip over this stuff. On the other hand, it tells what sort of thing
// we'll be doing here.


// The first two primitives parse ECMAScript code.
//
//   * `$ParseModule(loader, source, moduleName, address)` parses the string
//     `source` as an ES6 Module.  Returns a ModuleBody object.
//
//   * `$ParseScript(source)` parses the string `source` as an ES6 Script.
//     Returns a StatementList object.
//
// Both primitives detect ES "early errors" and throw `SyntaxError` or
// `ReferenceError`.
//
// Note that neither primitive runs any of the code in `source`.
//
// ModuleBody and StatementList objects are never exposed to user code. They
// are for use with the primitives below only. These two parsing primitives are
// the only way objects of these types are created.
//
// The following primitive extracts information from a ModuleBody object.
//
//   * `$ModuleRequests(body)` - Return an Array of strings, the module
//     specifiers as they appear in import declarations and module declarations
//     in the given module body, with duplicates removed. (This corresponds to
//     the ModuleRequests static semantics operation.)
//
// The following primitives operate on Module objects.

//   * `$CreateModule()` returns a new `Module` object. The object is
//     extensible.  It must not be exposed to scripts until it has been
//     populated and frozen.
//
var moduleInternalDataMap = CreateWeakMap();
function GetModuleInternalData(module) {
    return callFunction(std_WeakMap_get, moduleInternalDataMap, module);
}

function $CreateModule() {
    var module = std_Object_create(null);
    var moduleData = {
        dependencies: undefined,
        evaluated: false
    };
    callFunction(std_WeakMap_set, moduleInternalDataMap, module, moduleData);
    return module;
}

//   * `$IsModule(v)` returns true if `v` is a `Module` object.
//
function $IsModule(module) {
    return GetModuleInternalData(module) !== undefined;
}

//   * `$GetDependencies(module)` returns module.[[Dependencies]].  This is
//     either undefined or an array of Module objects, the modules whose bodies
//     are to be evaluated before the given module's body.  A return value of
//     undefined means the same thing as returning an empty array to the sole
//     caller, EnsureEvaluated().
//
function $GetDependencies(module) {
    return GetModuleInternalData(module).dependencies;
}

//   * `$SetDependencies(module, deps)` sets module.[[Dependencies]].
//
function $SetDependencies(module, deps) {
    GetModuleInternalData(module).dependencies = deps;
}

//   * `$EvaluateModuleBody(realm, mod)` runs the body of the given module in
//     the context of a given realm. Returns undefined.
//
//   * `$HasBeenEvaluated(mod)` returns true if mod has ever been passed to
//     $EvaluateModuleBody.
//
function $HasBeenEvaluated(module) {
    return GetModuleInternalData(module).evaluated;
}

// Loader iterators require a little private state.
//
//   * `$SetLoaderIteratorPrivate(iter, value)` stores `value` in an internal
//     data property of `iter`.
//
var loaderIteratorInternalDataMap = CreateWeakMap();
function $SetLoaderIteratorPrivate(iter, value) {
    callFunction(std_WeakMap_set, loaderIteratorInternalDataMap, iter, value);
}

//   * `$GetLoaderIteratorPrivate(iter)` retrieves the value previously stored
//     using $SetLoaderIteratorPrivate. If no value was previously stored,
//     throw a TypeError.
//
function $GetLoaderIteratorPrivate(iter) {
    if (!IsObject(iter)) {
        throw std_TypeError(
            "Loader Iterator method called on an incompatible " + typeof iter);
    }
    if (!callFunction(std_WeakMap_has, loaderIteratorInternalDataMap, iter)) {
        throw std_TypeError(
            "Loader Iterator method called on an incompatible object");
    }
    return callFunction(std_WeakMap_get, loaderIteratorInternalDataMap, iter);
}

// The following primitives deal with realms.
//
//   * `$CreateRealm(realmObject)` creates a new realm for evaluating module
//     and script code. This can be polyfilled in the browser using techniques
//     like
//
//       https://gist.github.com/wycats/8f5263a0bcc8e818b8e5
//
//   * `$IndirectEval(realm, source)` performs an indirect eval in the given
//     realm for the given script source.
//




//> # Modules: Semantics
//>
//> ## Module Loading
//>
//> ### Load Records
//>
//> The Load Record type represents an attempt to locate, fetch, translate, and
//> parse a single module.
//>
//> Each Load Record has the following fields:
//>
//>   * load.[[Status]] - One of: `"loading"`, `"loaded"`, `"linked"`, or `"failed"`.
//>
//>   * load.[[Name]] - The normalized name of the module being loaded, or
//>     **undefined** if loading an anonymous module.
//>
//>   * load.[[LinkSets]] - A List of all LinkSets that require this load to
//>     succeed.  There is a many-to-many relation between Loads and LinkSets.
//>     A single `import()` call can have a large dependency tree, involving
//>     many Loads.  Many `import()` calls can be waiting for a single Load, if
//>     they depend on the same module.
//>
//>   * load.[[Metadata]] - An object which loader hooks may use for any purpose.
//>     See Loader.prototype.locate.
//>
//>   * load.[[Address]] - The result of the locate hook.
//>
//>   * load.[[Source]] - The result of the translate hook.
//>
//>   * load.[[Body]] - Once the Load reaches the `"loaded"` state, a ModuleBody
//>     parse. (???terminology)
//>
//>   * load.[[Dependencies]] - Once the Load reaches the `"loaded"` state, a
//>     List of pairs. Each pair consists of two strings: a module name as it
//>     appears in an `import` or `export from` declaration in load.[[Body]],
//>     and the corresponding normalized module name.
//>
//>   * load.[[Exception]] - If load.[[Status]] is `"failed"`, the exception
//>     value that was thrown, causing the load to fail. Otherwise, **null**.
//>
//>   * load.[[Module]] - The Module object produced by this load, or
//>     undefined.  There are three ways for this to be populated, corresponding
//>     to the three permitted `instantiate` hook return types.
//>
//>     If the `instantiate` hook returns a Module, this internal data property
//>     is set immediately.
//>
//>     If the `instantiate` hook returns undefined, the module source is then
//>     parsed, and load.[[Module]] is set if parsing succeeds and there are no
//>     early errors.
//>
//>     Otherwise the `instantiate` hook returns a factory object, and load.[[Module]]
//>     is set during the link phase, when the factory.execute() method returns
//>     a Module.

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
//         .dependencies is a Map of strings (module requests)
//             to strings (full module names)
//         .factory is a callable object or null
//
//     Exactly one of `[.body, .factory]` is non-null.
//     If .body is null, then .dependencies is null.
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

//> #### CreateLoad(name) Abstract Operation
//>
//> The abstract operation CreateLoad creates and returns a new Load Record.
//> The argument name is either `undefined`, indicating an anonymous module, or
//> a normalized module name.
//>
//> The following steps are taken:
//>
function CreateLoad(name) {
    //> 1.  Let load be a new Load Record.
    return {
        //> 2.  Set the [[Status]] field of load to `"loading"`.
        status: "loading",
        //> 3.  Set the [[Name]] field of load to name.
        name: name,
        //> 4.  Set the [[LinkSets]] field of load to a new empty List.
        linkSets: CreateSet(),
        //> 5.  Let metadata be the result of ObjectCreate(%ObjectPrototype%).
        //> 6.  Set the [[Metadata]] field of load to metadata.
        metadata: {},
        //> 7.  Set the [[Address]] field of load to undefined.
        address: undefined,
        //> 8.  Set the [[Source]] field of load to undefined.
        source: undefined,
        //> 9.  Set the [[Body]] field of load to undefined.
        body: undefined,
        //> 10. Set the [[Factory]] field of load to undefined.
        factory: undefined,
        //> 11. Set the [[Exception]] field of load to undefined.
        exception: undefined,
        //> 12. Set the [[Module]] field of load to undefined.
        module: null
    };
    //> 13.  Return load.
}
//>


//> #### LoadFailed Functions
//>
//> A LoadFailed function is an anonymous function that marks a Load Record as
//> having failed.  All LinkSets that depend on the Load also fail.
//>
//> Each LoadFailed function has a [[Load]] internal slot.
//>
//> When a LoadFailed function F is called with argument exc, the following
//> steps are taken:
//>
function MakeClosure_LoadFailed(load) {
    return function (exc) {
        //> 1.  Assert: load.[[Status]] is `"loading"`.
        Assert(load.status === "loading");

        //> 2.  Set load.[[Status]] to `"failed".
        load.status = "failed";

        //> 3.  Set load.[[Exception]] to exc.
        load.exception = exc;

        //> 4.  Let linkSets be a copy of the list load.[[LinkSets]].
        //> 5.  For each linkSet in linkSets, in the order in which the LinkSet
        //>     Records were created,
        let sets = SetToArray(load.linkSets);
        callFunction(std_Array_sort, sets, (a, b) => b.timestamp - a.timestamp);
        for (let i = 0; i < sets.length; i++) {
            //>     1.  Call FinishLinkSet(linkSet, false, exc).
            FinishLinkSet(sets[i], false, exc);
        }

        //> 6.  Assert: load.[[LinkSets]] is empty.
        Assert(callFunction(std_Set_get_size, load.linkSets) === 0);
    };
}
//
// The attached LinkSets fail in timestamp order.  *Rationale*:  Any
// deterministic order would do.


// ## The loader pipeline

//> #### RequestLoad(loader, request, refererName, refererAddress) Abstract Operation
//>
//> The RequestLoad abstract operation normalizes the given module name,
//> request, and returns a promise that resolves to the value of a Load
//> object for the given module.
//>
//> The loader argument is a Loader object.
//>
//> request is the (non-normalized) name of the module to be imported, as it
//> appears in the import-declaration or as the argument to `loader.load()` or
//> `loader.import()`.
//>
//> refererName and refererAddress provide information about the context of
//> the `import()` call or import-declaration.  This information is passed to
//> all the loader hooks.
//>
//> If the requested module is already in the loader's module registry,
//> RequestLoad returns a promise for a Load with the [[Status]] field set to
//> `"linked"`. If the requested module is loading or loaded but not yet
//> linked, RequestLoad returns a promise for an existing Load object from
//> loader.[[Loads]]. Otherwise, RequestLoad starts loading the module and
//> returns a promise for a new Load Record.
//>
//> The following steps are taken:
//>
function RequestLoad(loader, request, refererName, refererAddress) {
    var loaderData = GetLoaderInternalData(loader);

    // Bug: This leaks the use of promises in the implementation, since the
    //      `Promise` constructor may have had its @@create mutated. We
    //      need a slightly better strategy for creating async logic in the
    //      spec.
    var p = callFunction(std_Promise_fulfill, std_Promise, undefined);
    p = callFunction(std_Promise_then, p, function (_) {
        // Call the `normalize` hook to get a normalized module name.  See the
        // comment on `normalize()`.
        //
        // Errors that happen during this step propagate to the caller.
        //
        return loader.normalize(request, refererName, refererAddress);
    });
    p = callFunction(std_Promise_then, p, function (normalized) {
        normalized = ToString(normalized);

        // If the module has already been linked, we are done.
        let existingModule = callFunction(std_Map_get, loaderData.modules, normalized);
        if (existingModule !== undefined) {
            return std_Promise_fulfill(
                {status: "linked", name: normalized, module: existingModule});
        }

        // If the module is already loading or loaded, we are done.
        let load = callFunction(std_Map_get, loaderData.loads, normalized);
        if (load !== undefined) {
            Assert(load.status === "loading" || load.status === "loaded");
            return std_Promise_fulfill(load);
        }

        // Start a new Load.
        load = CreateLoad(normalized);
        callFunction(std_Map_set, loaderData.loads, normalized, load);

        // Bug: This leaks the use of promises in the implementation, since the
        //      `Promise` constructor may have had its @@create mutated. We
        //      need a slightly better strategy for creating async logic in the
        //      spec.
        var p = new std_Promise(MakeClosure_CallLocate(loader, load));
        ProceedToFetch(loader, load, p);
        return load;
    });
    return p;
}

function ProceedToFetch(loader, load, p) {
    return callFunction(std_Promise_then, p, MakeClosure_CallFetch(loader, load));
}

function ProceedToTranslate(loader, load, p) {
    p = callFunction(std_Promise_then, p,
                     MakeClosure_CallTranslate(loader, load));
    p = callFunction(std_Promise_then, p,
                     MakeClosure_CallInstantiate(loader, load));
    p = callFunction(std_Promise_then, p,
                     MakeClosure_InstantiateSucceeded(loader, load));
    callFunction(std_Promise_catch, p,
                 MakeClosure_LoadFailed(load));
}

function MakeClosure_CallLocate(loader, load) {
    return function (resolve, reject) {
        resolve(loader.locate({
            name: load.name,
            metadata: load.metadata
        }));
    };
}

function MakeClosure_CallFetch(loader, load) {
    return function (address) {
        if (callFunction(std_Set_get_size, load.linkSets) === 0)
            return;
        load.address = address;
        return loader.fetch({
            name: load.name,
            metadata: load.metadata,
            address: address
        });
    };
}

function MakeClosure_CallTranslate(loader, load) {
    return function (source) {
        if (callFunction(std_Set_get_size, load.linkSets) === 0)
            return;
        return loader.translate({
            name: load.name,
            metadata: load.metadata,
            address: load.address,
            source: source
        });
    };
}

function MakeClosure_CallInstantiate(loader, load) {
    return function (source) {
        if (callFunction(std_Set_get_size, load.linkSets) === 0)
            return;
        load.source = source;
        return loader.instantiate({
            name: load.name,
            metadata: load.metadata,
            address: load.address,
            source: source
        });
    };
}

// **`InstantiateSucceeded`** - This is called once the `instantiate` hook
// succeeds. Continue module loading by interpreting the hook's result and
// calling FinishLoad if necessary.
function MakeClosure_InstantiateSucceeded(loader, load) {
    return function (instantiateResult) {
        // Interpret `instantiateResult`.  See comment on the `instantiate()`
        // method.
        if (instantiateResult === undefined) {
            let body = $ParseModule(loader, load.source, load.name, load.address);

            // FinishLoad returns a promise. The only way to propagate errors
            // is to return it.
            return FinishLoad(load, loader, body);
        } else if (!IsObject(instantiateResult)) {
            throw std_TypeError("instantiate hook must return an object or undefined");
        } else if ($IsModule(instantiateResult)) {
            let mod = instantiateResult;
            let name = load.name;
            if (name !== undefined) {
                var loaderData = GetLoaderInternalData(loader);

                if (callFunction(std_Map_has, loaderData.modules, name)) {
                    throw std_TypeError("fetched module \"" + name + "\" " +
                                        "but a module with that name is already " +
                                        "in the registry");
                }
                callFunction(std_Map_set, loaderData.modules, name, mod);
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
    Assert(load.status === "loading");
    Assert(callFunction(std_Set_get_size, load.linkSets) !== 0);

    let refererName = load.name;
    let sets = SetToArray(load.linkSets);

    let moduleRequests = $ModuleRequests(body);

    // For each new dependency, create a new Load Record, if necessary, and add
    // it to the same LinkSet.
    //
    // The module-specifiers in import-declarations are not necessarily
    // normalized module names.  We pass them to RequestLoad which will
    // call the `normalize` hook.
    //
    let dependencies = CreateMap();
    let loadPromises = [];
    for (let i = 0; i < moduleRequests.length; i++) {
        let request = moduleRequests[i];
        let p = RequestLoad(loader, request, refererName, load.address);
        p = callFunction(std_Promise_then, p, function (depLoad) {
            callFunction(std_Map_set, dependencies, request, depLoad.name);
            if (depLoad.status !== "linked") {
                for (let j = 0; j < sets.length; j++)
                    AddLoadToLinkSet(sets[j], depLoad);
            }
        });
        callFunction(std_Array_push, loadPromises, p);
    }

    var p = callFunction(std_Promise_all, std_Promise, loadPromises);
    return callFunction(std_Promise_then, p, function (_) {
        load.status = "loaded";
        load.body = body;
        load.dependencies = dependencies;

        // For determinism, finish linkable LinkSets in timestamp order.
        // (NOTE: If it turns out that Promises fire in a nondeterministic
        // order, then there's no point sorting this array here.)
        callFunction(std_Array_sort, sets, (a, b) => b.timestamp - a.timestamp);
        for (let i = 0; i < sets.length; i++)
            LinkSetOnLoad(sets[i], load);
    });
}

//> #### OnEndRun(load, mod) Abstract Operation
//>
// Called when the `instantiate` hook returns a Module object.
function OnEndRun(load, mod) {
    Assert(load.status === "loading");
    load.status = "linked";
    load.module = mod;

    let sets = SetToArray(load.linkSets);
    callFunction(std_Array_sort, sets, (a, b) => b.timestamp - a.timestamp);
    for (let i = 0; i < sets.length; i++)
        LinkSetOnLoad(sets[i], load);
}



// ## Notes on error handling
//
// Most errors that can occur during module loading are related to either a
// specific in-flight `Load` (in `loader.loads`) or a specific `LinkSet`.
//
// When such an error occurs:
//
//  1. Compute the set F of `LinkSet`s we are going to fail.
//
//       * If the error is related to a single `LinkSet` (that is, it is a link
//         error or an runtime error in a module), then F = a set containing
//         just that `LinkSet`.
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
//

//> ### LinkSet Records
//>
//> A LinkSet Record represents a call to `loader.define()`, `.load()`,
//> `.module()`, or `.import()`.
//>
//> Each LinkSet Record has the following fields:
//>
//>   * linkSet.[[Loader]] - The Loader object that created this LinkSet.
//>
//>   * linkSet.[[Loads]] - A List of the Load Records that must finish loading
//>     before the modules can be linked and evaluated.
//>
//>   * linkSet.[[Done]] - A Promise that becomes fulfilled when all dependencies
//>     are loaded and linked together.
//>
//>   * linkSet.[[Resolve]] and linkSet.[[Reject]] - Functions used to resolve
//>     or reject linkSet.[[Done]].
//>

//> #### CreateLinkSet(loader, startingLoad) Abstract Operation
//>
function CreateLinkSet(loader, startingLoad) {
    var loaderData = GetLoaderInternalData(loader);
    var resolve, reject;
    var done = new std_Promise(function (res, rej) {
        resolve = res;
        reject = rej;
    });
    var linkSet = {
        loader: loader,
        loads: CreateSet(),
        done: done,
        resolve: resolve,
        reject: reject,
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

//> #### LinkSetAddLoadByName(linkSet, name) Abstract Operation
//>
//> If a module with the given normalized name is loading or loaded but not
//> linked, add the `Load` to the given linkSet.
//>
function LinkSetAddLoadByName(linkSet, name) {
    var loaderData = GetLoaderInternalData(linkSet.loader);
    if (!callFunction(std_Map_has, loaderData.modules, name)) {
        // We add `depLoad` even if it is done loading, for two reasons. The
        // association keeps the Load alive (Load Records are
        // reference-counted; see `FinishLinkSet`). Separately, `depLoad` may
        // have dependencies that are still laoding.
        let depLoad = callFunction(std_Map_get, loaderData.loads, name);
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

    if (!callFunction(std_Set_has, linkSet.loads, load)) {
        callFunction(std_Set_add, linkSet.loads, load);
        callFunction(std_Set_add, load.linkSets, linkSet);
        if (load.status === "loading") {
            linkSet.loadingCount++;
        } else {
            // Transitively add not-yet-linked dependencies.
            Assert(load.status == "loaded");
            let names = MapValuesToArray(load.dependencies);
            for (let i = 0; i < names.length; i++)
                LinkSetAddLoadByName(linkSet, names[i]);
        }
    }
}

//> #### LinkSetOnLoad(linkSet, load) Abstract Operation
//>
//> `FinishLoad` calls this after one `Load` successfully finishes, and after
//> kicking off loads for all its dependencies.
//>
function LinkSetOnLoad(linkSet, load) {
    Assert(callFunction(std_Set_has, linkSet.loads, load));
    Assert(load.status === "loaded" || load.status === "linked");

    //> 1.  Repeat for each load in linkSet.[[Loads]],
    //>     1.  If load.[[Status]] is `"loading"`, then return.
    if (--linkSet.loadingCount !== 0)
        return;

    try {
        //> 2.  Let status be the result of calling the Link abstract
        //>     operation passing linkSet.[[Loads]] and
        //>     linkSet.[[Loader]] as arguments.
        LinkModules(linkSet);
    } catch (exc) {
        //> 3.  If status is an abrupt completion, then
        //>     1. Call FinishLinkSet(linkSet, false, status.[[value]]).
        FinishLinkSet(linkSet, false, exc);

        //>     2. Return.
        return;
    }
    //> 4. Call FinishLinkSet(linkSet, true, undefined).
    FinishLinkSet(linkSet, true, undefined);
}

//> #### FinishLinkSet(linkSet, succeeded, exc) Abstract Operation
//>
//> Detach the given LinkSet Record from all Load Records and schedule either
//> the success callback or the error callback.
//>
function FinishLinkSet(linkSet, succeeded, exc) {
    let loads = SetToArray(linkSet.loads);
    let loaderData = GetLoaderInternalData(linkSet.loader);
    for (let i = 0; i < loads.length; i++) {
        let load = loads[i];

        // Detach load from linkSet.
        Assert(callFunction(std_Set_has, load.linkSets, linkSet));
        callFunction(std_Set_delete, load.linkSets, linkSet);

        // If load is not needed by any surviving LinkSet, drop it.
        if (callFunction(std_Set_get_size, load.linkSets) === 0) {
            let name = load.name;
            if (name !== undefined) {
                let currentLoad = callFunction(std_Map_get, loaderData.loads, name);
                if (currentLoad === load)
                    callFunction(std_Map_delete, loaderData.loads, name);
            }
        }
    }

    if (succeeded)
        linkSet.resolve(undefined);
    else
        linkSet.reject(exc);
}

// **Timing and grouping of dependencies** - Consider
//
//     loader.module('module x from "x"; module y from "y";');
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


// ## Module loading entry points

function MakeClosure_AsyncStartLoadPartwayThrough(
    loader, loaderData, name, step, metadata, address, source)
{
    //> ### AsyncStartLoadPartwayThrough ( resolve, reject )
    //>
    //> The following steps are taken:
    //>
    return function (resolve, reject) {
        //> 1.  Let F be this function object.
        //> 1.  Let loader be F.[[Loader]].
        //> 1.  Let name be F.[[ModuleName]].
        //> 1.  Let metadata be F.[[ModuleMetadata]].
        //> 1.  Let address be F.[[ModuleAddress]].
        //> 1.  Let source be F.[[ModuleSource]].

        //> 1.  If loader.[[Modules]] contains an entry whose [[key]] is equal
        //>     to name, throw a TypeError exception.
        if (callFunction(std_Map_has(loaderData.modules, name))) {
            throw std_TypeError(
                "can't define module \"" + name + "\": already loaded");
        }

        //> 1.  If loader.[[Loads]] contains an entry whose [[key]] is equal
        //>     to name, throw a TypeError exception.
        if (callFunction(std_Map_has(loaderData.loads, name))) {
            throw std_TypeError(
                "can't define module \"" + name + "\": already loading");
        }

        // Make a LinkSet.  Pre-populate it with a Load object for the
        // given module.  Start the Load process at the `translate` hook.

        //> 1.  Let load be the result of calling the CreateLoad abstract
        //>     operation passing name as the single argument.
        let load = CreateLoad(name);

        //> 1.  Set load.[[Metadata]] to metadata.
        load.metadata = metadata;

        //> 1.  Let linkSet be the result of calling the CreateLinkSet abstract
        //>     operation passing loader and load as arguments.
        let linkSet = CreateLinkSet(loader, load);

        //> 1.  Add the record {[[key]]: name, [[value]]: load} to
        //>     loader.[[Loads]].
        callFunction(std_Map_set, loaderData.loads, name, load);
        //> 1.  Call the [[Call]] internal method of resolve with arguments
        //>     null and (linkSet.[[Done]]).
        resolve(linkSet.done);

        //>???
        if (step == "locate") {
            ProceedToLocate(loader, load, std_Promise_resolve(name));
        } else if (step == "fetch") {
            ProceedToFetch(loader, load, std_Promise_resolve(address));
        } else {
            //> ???
            $Assert(step == "translate");

            //> 1.  Set load.[[Address]] to address.
            load.address = address;

            //> 1.  Let sourcePromise be the result of calling the [[Call]]
            //>     internal method of %PromiseFulfill% passing null and
            //>     (source) as arguments.
            var sourcePromise = std_Promise_fulfill(source);

            //> 1.  Call the ProceedToTranslate abstract operation passing loader,
            //>     load, and sourcePromise as arguments.
            ProceedToTranslate(loader, load, sourcePromise);
        }
    };
}

function MakeClosure_CreateLinkSetForLoad(loader) {
    //> ### CreateLinkSetForLoad ( load )
    //>
    //> The following steps are taken:
    //>
    return function (load) {
        //> 1.  Let F be this function object.
        //> 2.  Let loader be F.[[Loader]].
        //> 3.  Let linkSet be the result of calling the CreateLinkSet abstract
        //>     operation passing loader and load as arguments.
        let linkSet = CreateLinkSet(loader, load);

        //> 4.  Return linkSet.[[Done]].
        return linkSet.done;
    };
    //>
}

function MakeClosure_EvaluateLoadedModule(loader, load) {
    //> ### EvaluateLoadedModule ( )
    //>
    //> The following steps are taken:
    //>
    return function (_) {
        //> 1.  Let F be this function.
        //> 2.  Let loader be F.[[Loader]].
        //> 3.  Let load be F.[[Load]].

        //> 4.  Assert: load.[[Status]] is `"linked"`.
        Assert(load.status === "linked");

        //> 5.  Let module be load.[[Module]].
        var module = load.module;

        //> 6.  Call EnsureEvaluated(module, (), loader).
        EnsureEvaluatedHelper(module, loader);

        //> 7.  Return module.
        return module;
    };
    //>
}

function MakeClosure_AsyncLoadAndEvaluateModule(loader) {
    //> ### AsyncLoadAndEvaluateModule ( load )
    //>
    //> The following steps are taken:
    //>
    return function (load) {
        //> 1.  Let F be this function.
        //> 1.  Let loader be F.[[Loader]].

        //> 1.  If load.[[Status]] is **linked**, then the following steps are
        //>     taken:
        if (load.status === "linked") {
            //>     1.  Let module be load.[[Module]].
            var module = load.module;

            //>     1.  Call EnsureEvaluated(module, (), loader).
            EnsureEvaluatedHelper(module, loader);

            //>     1.  Return module.
            return module;
        }

        //>     1.  Let linkSet be the result of calling the CreateLinkSet
        //>         abstract operation passing loader and load as
        //>         arguments.
        var linkSet = CreateLinkSet(loader, load);

        //>     1.  Let G be a new anonymous function object as define in
        //>         EvaluateLoadedModule.
        //>     1.  Set G.[[Loader]] to loader.
        //>     1.  Set G.[[Load]] to load.
        //>     1.  Let p be the result of calling the [[Call]] internal
        //>         method of %PromiseThen% passing linkSet.[[Done]] and
        //>         (G) as arguments.
        //>     1.  Return p.
        return callFunction(std_Promise_then, linkSet.done,
                            MakeClosure_EvaluateLoadedModule(loader, load));
    };
}



//> ## Module Linking
//>
//> (Please see specs/linking.docx.)



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
    callFunction(std_Set_add, seen, mod);

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
            if (!callFunction(std_Set_has, seen, dep))
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
    let seen = CreateSet();
    let loaderData = GetLoaderInternalData(loader);
    EnsureEvaluated(mod, seen, loaderData);

    // All evaluation succeeded. As an optimization for future EnsureEvaluated
    // calls, drop this portion of the dependency graph.  (This loop cannot be
    // fused with the evaluation loop above; the meaning would change on error
    // for certain dependency graphs containing cycles.)
    seen = SetToArray(seen);
    for (let i = 0; i < seen.length; i++)
        $SetDependencies(seen[i], undefined);
}

function ConstantGetter(value) {
    return function () { return value; };
}

// ## The Module factory
//
// The `Module` factory function reflectively creates module instance objects.
//
// A module instance object:
//
//   * has null [[Prototype]].
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
//   * is non-extensible by the time it is exposed to ECMAScript code.


//> ## Module Objects
//>
//> ### The Module Factory Function
//>
//> #### Module ( obj )
//> 
//> When the `Module` function is called with optional argument obj, the
//> following steps are taken:
//>
function Module(obj) {
    //> 1.  Let mod be the result of calling the CreateLinkedModuleInstance
    //>     abstract operation.
    var mod = $CreateModule();
    //> 1.  Let keys be the result of calling the ObjectKeys abstract
    //>     operation passing obj as the argument.
    //> 1.  ReturnIfAbrupt(keys).
    var keys = std_Object_keys(obj);
    //> 1.  For each key in keys, do
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        //>     1.  Let value be the result of calling the [[Get]] internal
        //>         method of obj passing key and true as arguments.
        var value = obj[key];
        //>     1.  ReturnIfAbrupt(value).
        //>     1.  Let thrower be the %ThrowTypeError% intrinsic function
        //>         Object.
        //>     1.  Let F be the result of calling the CreateConstantGetter
        //>         abstract operation passing value as the argument.
        //>     1.  Let desc be the PropertyDescriptor {[[Configurable]]:
        //>         false, [[Enumerable]]: true, [[Get]]: F, [[Set]]:
        //>         thrower}.
        //>     1.  Let status be the result of calling the
        //>         DefinePropertyOrThrow abstract operation passing mod, key,
        //>         and desc as arguments.
        //>     1.  ReturnIfAbrupt(status).
        std_Object_defineProperty(mod, keys[i], {
            configurable: false,
            enumerable: true,
            get: ConstantGetter(value),
            set: undefined
        });
    }
    //> 1.  Call the [[PreventExtensions]] internal method of mod.
    std_Object_preventExtensions(mod);
    //> 1.  Return mod.
    return mod;
}

// The `Module` function is not a constructor so its `prototype` is `null`.
Module.prototype = null;

// ## The Realm class

//> ## Realm Objects

// Implementation note: Since ES6 does not have support for private state or
// private methods, the "internal data properties" of Realm objects are stored
// on a separate object which is not accessible from user code.
//
// So what the specification refers to as `realmObject.[[Realm]]` is implemented
// as `GetRealmInternalData(realmObject).realm`.
//
// The simplest way to connect the two objects without exposing this internal
// data to user code is to use a `WeakMap`.
//
let realmInternalDataMap = CreateWeakMap();

//> ### The Realm Constructor
//>
//> #### new Realm ( options, initializer )
//>
function Realm(options, initializer) {
    //> 1.  Let realmObject be the this value.
    //
    // Bug: This calls Realm[@@create] directly.  The spec will instead make
    // `new Realm(options)` equivalent to
    // `Realm.[[Call]](Realm[@@create](), List [options])`.
    // In other words, Realm[@@create] will be called *before* Realm.
    // We'll change that when symbols and @@create are implemented.
    var realmObject = callFunction(Realm["@@create"], Realm);

    //> 1.  If Type(realmObject) is not Object, throw a TypeError exception.
    //> 1.  If realmObject does not have all of the internal properties of a
    //>     Realm object, throw a TypeError exception.
    if (!IsObject(realmObject) ||
        !callFunction(std_WeakMap_has, realmInternalDataMap, this))
    {
        throw std_TypeError("not a Realm object");
    }

    var realmData = callFunction(std_WeakMap_get, realmInternalDataMap, realmObject);
    if (realmData === undefined)
        throw std_TypeError("Realm object expected");

    //> 1.  If realmObject.[[Realm]] is not undefined, throw a TypeError
    //>     exception.
    if (realmData.realm !== undefined)
        throw std_TypeError("Realm object cannot be intitialized more than once");

    //> 1.  If options is not undefined and Type(options) is not Object, throw
    //>     a TypeError exception.
    if (options !== undefined && !IsObject(options))
        throw std_TypeError("options must be an object or undefined");

    //> 1.  Let realm be the result of CreateRealm(realmObject).
    let realm = $CreateRealm(realmObject);

    //> 1.  If options is undefined, then let options be the result of calling
    //>     ObjectCreate(%ObjectPrototype%, ()).
    if (options === undefined) {
        options = {};
    }

    //> 1.  Else, if Type(options) is not Object, throw a TypeError
    //>     exception.
    if (!IsObject(options)) {
        throw std_TypeError("options must be an object or undefined");
    }

    //> 1.  Let evalHooks be the result of calling the [[Get]] internal
    //>     method of options passing `"eval"` and true as arguments.
    //> 1.  ReturnIfAbrupt(evalHooks).
    //> 1.  If evalHooks is undefined then let evalHooks be the result of
    //>     calling ObjectCreate(%ObjectPrototype%, ()).
    let evalHooks = UnpackOption(options, "eval", () => ({}));

    //> 1.  Else, if Type(evalHooks) is not Object, throw a TypeError
    //>     exception.
    if (!IsObject(evalHooks)) {
        throw std_TypeError("options.eval must be an object or undefined");
    }

    //> 1.  Let directEval be the result of calling the [[Get]] internal
    //>     method of evalHooks passing `"direct"` and true as arguments.
    //> 1.  ReturnIfAbrupt(directEval).
    //> 1.  If directEval is undefined then let directEval be the result of
    //>     calling ObjectCreate(%ObjectPrototype%, ()).
    let directEval = UnpackOption(evalHooks, "direct", () => ({}));

    //> 1.  Else, if Type(directEval) is not Object, throw a TypeError
    //>     exception.
    if (!IsObject(directEval)) {
        throw std_TypeError("options.eval.direct must be an object or undefined");
    }

    //> 1.  Let translate be the result of calling the [[Get]] internal
    //>     method of directEval passing `"translate"` and true as
    //>     arguments.
    //> 1.  ReturnIfAbrupt(translate).
    let translate = UnpackOption(directEval, "translate");

    //> 1.  If translate is not undefined and IsCallable(translate) is false,
    //>     throw a TypeError exception.
    if (translate !== undefined && !IsCallable(translate)) {
        throw std_TypeError("translate hook is not callable");
    }

    //> 1.  Set realm.[[translateDirectEvalHook]] to translate.
    realm.translateDirectEvalHook = translate;

    //> 1.  Let fallback be the result of calling the [[Get]] internal method
    //>     of directEval passing `"fallback"` and true as arguments.
    //> 1.  ReturnIfAbrupt(fallback).
    let fallback = UnpackOption(directEval, "fallback");

    //> 1.  If fallback is not undefined and IsCallable(fallback) is false,
    //>     throw a TypeError exception.
    if (fallback !== undefined && !IsCallable(fallback)) {
        throw std_TypeError("fallback hook is not callable");
    }

    //> 1.  Set realm.[[fallbackDirectEvalHook]] to fallback.
    realm.fallbackDirectEvalHook = fallback;

    //> 1.  Let indirectEval be the result of calling the [[Get]] internal
    //>     method of options passing `"indirect"` and true as arguments.
    //> 1.  ReturnIfAbrupt(indirectEval).
    let indirectEval = UnpackOption(evalHooks, "indirect");

    //> 1.  If indirectEval is not undefined and IsCallable(indirectEval) is
    //>     false, throw a TypeError exception.
    if (indirectEval !== undefined && !IsCallable(indirectEval)) {
        throw std_TypeError("indirect eval hook is not callable");
    }

    //> 1.  Set realm.[[indirectEvalHook]] to indirectEval.
    realm.indirectEvalHook = indirectEval;

    //> 1.  Let Function be the result of calling the [[Get]] internal method
    //>     of options passing `"Function"` and true as arguments.
    //> 1.  ReturnIfAbrupt(Function).
    let Function = UnpackOption(options, "Function");

    //> 1.  If Function is not undefined and IsCallable(Function) is false,
    //>     throw a TypeError exception.
    if (Function !== undefined && !IsCallable(Function)) {
        throw std_TypeError("Function hook is not callable");
    }

    //> 1.  Set realm.[[FunctionHook]] to Function.
    realm.FunctionHook = Function;

    //> 1.  Set realmObject.[[Realm]] to realm.
    realmData.realm = realm;

    //> 1.  If initializer is not undefined then the following steps are taken:
    if (initializer !== undefined) {
        //>     1.  If IsCallable(initializer) is false, throw a TypeError
        //>         exception.
        if (!IsCallable(initializer)) {
            throw std_TypeError("initializer is not callable");
        }

        //>     1.  Let builtins be the result of calling
        //>         ObjectCreate(%ObjectPrototype%, ()).
        //>     1.  Call the DefineBuiltinProperties abstract operation passing
        //>         realm and builtins as arguments.
        //>     1.  Let status be the result of calling the [[Call]] internal
        //>         method of the initializer function, passing realmObject as
        //>         the this value and builtins as the single argument.
        //>     1.  ReturnIfAbrupt(status).
        callFunction(initializer, realmObject, realm.builtins);
    }

    //> 1.  Return realmObject.
    return realmObject;
}

//> ### Properties of the Realm Prototype Object
//>

def(Realm.prototype, {

    //> #### Realm.prototype.global
    //>
    //> `Realm.prototype.global` is an accessor property whose set accessor
    //> function is undefined. Its get accessor function performs the following
    //> steps:
    //>
    get global() {
        //> 1. Let realmObject be this Realm object.
        //> 1. If realmObject does not have all the internal properties of a
        //>    Realm object, throw a TypeError exception.
        if (!IsObject(this) ||
            !callFunction(std_WeakMap_has, realmInternalDataMap, this))
        {
            throw std_TypeError("not a Realm object");
        }

        let internalData = GetRealmInternalData(this);

        //> 1. Return realmObject.[[Realm]].[[globalThis]].
        return internalData.realm.globalThis;
    },
    //>

    //> #### Realm.prototype.eval ( source )
    //>
    //> The following steps are taken:
    //>
    eval: function(source) {
        //> 1.  Let realmObject be this Realm object.
        //> 1.  If Type(realmObject) is not Object or realmObject does not have
        //>     all the internal properties of a Realm object, throw a
        //>     TypeError exception.
        if (!IsObject(this) ||
            !callFunction(std_WeakMap_has, realmInternalDataMap, this))
        {
            throw std_TypeError("not a Realm object");
        }

        let internalData = GetRealmInternalData(this);

        //> 1.  Return the result of calling the IndirectEval abstract operation
        //>     passing realmObject.[[Realm]] and source as arguments.
        return $IndirectEval(internalData.realm, source);
    }

});

//> #### Realm [ @@create ] ( )
//>
//> The @@create method of the builtin Realm constructor performs the
//> following steps:
//>
var Realm_create = function create() {
    //> 1.  Let F be the this value.
    //> 2.  Let realmObject be the result of calling
    //>     OrdinaryCreateFromConstructor(F, "%RealmPrototype%", ([[Realm]])).
    var realmObject = std_Object_create(this.prototype);

    // The fields are initially undefined but are populated when the
    // constructor runs.
    var internalData = {

        // **`realmData.realm`** is an ECMAScript Realm. It determines the
        // global scope and intrinsics of all code this Realm object runs.
        realm: undefined

    };
    callFunction(std_WeakMap_set, realmInternalDataMap, realmObject, internalData);

    //> 3.  Return realm.
    return realmObject;
};

def(Realm, {"@@create": Realm_create});

// Get the internal data for a given `Realm` object.
function GetRealmInternalData(value) {
    // Realm methods could be placed on wrapper prototypes like String.prototype.
    if (typeof value !== "object")
        throw std_TypeError("Realm method or accessor called on incompatible primitive");

    let internalData = callFunction(std_WeakMap_get, realmInternalDataMap, value);
    if (internalData === undefined)
        throw std_TypeError("Realm method or accessor called on incompatible object");
    return internalData;
}


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
//>     asynchronous module loads.


//> ### The Loader Constructor
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
var loaderInternalDataMap = CreateWeakMap();

// Get the internal data for a given `Loader` object.
function GetLoaderInternalData(value) {
    // Loader methods could be placed on wrapper prototypes like String.prototype.
    if (typeof value !== "object")
        throw std_TypeError("Loader method called on incompatible primitive");

    let internalData = callFunction(std_WeakMap_get, loaderInternalDataMap, value);
    if (internalData === undefined)
        throw std_TypeError("Loader method called on incompatible object");
    return internalData;
}

//> #### Loader ( options )
//>
//> When the `Loader` function is called with optional argument options the
//> following steps are taken:
//>
function Loader(options={}) {
    // Bug: In step 1, this implementation calls Loader[@@create] directly.  The spec will instead make
    // `new Loader(options)` equivalent to
    // `Loader.[[Call]](Loader[@@create](), List [options])`.
    // In other words, Loader[@@create] must be called *before* Loader.
    // We'll change that when symbols and @@create are implemented.
    //
    //> 1.  Let loader be the this value.
    var loader = callFunction(Loader["@@create"], Loader);

    //> 2.  If Type(loader) is not Object, throw a TypeError exception.
    //> 3.  If loader does not have all of the internal properties of a Loader
    //>     Instance, throw a TypeError exception.
    var loaderData = callFunction(std_WeakMap_get, loaderInternalDataMap, loader);
    if (loaderData === undefined)
        throw std_TypeError("Loader object expected");

    //> 4.  If loader.[[Modules]] is not undefined, throw a TypeError
    //>     exception.
    if (loaderData.modules !== undefined)
        throw std_TypeError("Loader object cannot be intitialized more than once");

    //> 5.  If Type(options) is not Object, throw a TypeError exception.
    if (!IsObject(options))
        throw std_TypeError("options must be an object or undefined");

    //> 6.  Let realmObject be the result of calling the [[Get]] internal
    //>     method  of options with arguments `"realm"` and options.
    //> 7.  ReturnIfAbrupt(realmObject).

    var realmObject = options.realm;
    var realm;

    //> 8.  If realmObject is undefined, let realm be the Realm of the running
    //>     execution context.
    //> 9.  Else if Type(realmObject) is not Object or realmObject does not
    //>     have all the internal properties of a Realm object, throw a
    //>     TypeError exception.
    if (realmObject !== undefined &&
        (!IsObject(realmObject) ||
         !callFunction(std_WeakMap_has, realmInternalDataMap, realmObject)))
    {
        throw std_TypeError("options.realm is not a Realm object");
    } else {
        //> 10. Else let realm be realmObject.[[Realm]].
        realm = GetRealmInternalData(realmObject).realm;
    }

    //> 11. For each name in the List (`"normalize"`, `"locate"`, `"fetch"`,
    //>     `"translate"`, `"instantiate"`),
    let hooks = ["normalize", "locate", "fetch", "translate", "instantiate"];
    for (let i = 0; i < hooks.length; i++) {
        let name = hooks[i];
        //>     1.  Let hook be the result of calling the [[Get]] internal
        //>         method of options with arguments name and options.
        //>     2.  ReturnIfAbrupt(hook).
        var hook = options[name];
        //>     3.  If hook is not undefined,
        if (hook !== undefined) {
            //>         1.  Let result be the result of calling the
            //>             [[DefineOwnProperty]] internal method of loader
            //>             passing name and the Property Descriptor {[[Value]]:
            //>             hook, [[Writable]]: true, [[Enumerable]]: true,
            //>             [[Configurable]]: true} as arguments.
            //>         2.  ReturnIfAbrupt(result).
            std_Object_defineProperty(loader, name, {
                configurable: true,
                enumerable: true,
                value: hook,
                writable: true
            });
        }
    }

    //> 12. Set loader.[[Modules]] to a new empty List.
    loaderData.modules = CreateMap();
    //> 13. Set loader.[[Loads]] to a new empty List.
    loaderData.loads = CreateMap();
    //> 14. Set loader.[[Realm]] to realm.
    loaderData.realm = realm;

    //> 15. Return loader.
    return loader;
}
//
// In step 8, this implementation represents the implicit Realm as
// undefined, so we do nothing.
//
// In step 10, hooks provided via `options` are stored as ordinary data
// properties of the new Loader object.  *Rationale*: The Loader class
// contains default implementations of each hook. This way the hooks can be
// called unconditionally, and either the user-provided hook or the default
// is called. Furthermore, Loader subclasses can add methods with the
// appropriate names and use `super()` to invoke the base-class behavior.
//
// The algorithm is designed so that all steps that could complete abruptly
// precede the steps that initialize the internal data properties of the new
// loader.

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
var Loader_create = function create() {
    //> 1.  Let F be the this value.
    //> 2.  Let loader be the result of calling
    //>     OrdinaryCreateFromConstructor(F, "%LoaderPrototype%", ([[Modules]],
    //>     [[Loads]], [[Realm]])).
    var loader = std_Object_create(this.prototype);

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
        // `loader.define()/.load()/.module()/.import()` can cooperate to fetch
        // what they need only once.
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
    callFunction(std_WeakMap_set, loaderInternalDataMap, loader, internalData);

    //> 3.  Return loader.
    return loader;
};

def(Loader, {"@@create": Loader_create});

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
function UnpackOption(options, name, thunk) {
    let value;
    return (options === undefined || ((value = options[name]) === undefined))
         ? (thunk ? thunk() : undefined)
         : value;
}

def(Loader.prototype, {

    //> #### Loader.prototype.realm
    //>
    //> `Loader.prototype.realm` is an accessor property whose set accessor
    //> function is undefined. Its get accessor function performs the following
    //> steps:
    //>
    get realm() {
        //> 1.  Let loader be this Loader object.
        //> 1.  If Type(loader) is not Object or loader does not have all the
        //>     internal properties of a Loader object, throw a TypeError
        //>     exception.
        if (!IsObject(this) ||
            !callFunction(std_WeakMap_has, loaderInternalDataMap, this))
        {
            throw std_TypeError("not a Loader object");
        }

        //> 1.  Return loader.[[Realm]].[[realmObject]].
        return GetLoaderInternalData(this).realm.realmObject;
    },
    //>

    //> #### Loader.prototype.global
    //>
    //> `Loader.prototype.global` is an accessor property whose set accessor
    //> function is undefined. Its get accessor function performs the following
    //> steps:
    //>
    get global() {
        //> 1.  Let loader be this Loader object.
        //> 1.  If Type(loader) is not Object or loader does not have all the
        //>     internal properties of a Loader object, throw a TypeError
        //>     exception.
        if (!IsObject(this) ||
            !callFunction(std_WeakMap_has, loaderInternalDataMap, this))
        {
            throw std_TypeError("not a Loader object");
        }

        //> 1.  Return loader.[[Realm]].[[globalThis]].
        return GetLoaderInternalData(this).realm.globalThis;
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

    // **options.address** &ndash; Several Loader methods accept an `options`
    // parameter.  For these methods, `options.address`, if present, is passed
    // to the `translate` and `instantiate` hooks as `load.address`, and to the
    // `normalize` hook for each dependency, as `refererAddress`.  The default
    // loader hooks ignore it, though.
    //
    // Implementations may also store `options.address` in the compiled module
    // body and use it for `Error().fileName`, `Error().stack`, and developer
    // tools; but such use is outside the scope of the language specification.


    //> #### Loader.prototype.define ( name, source, options = undefined )
    //>
    //> The `define` method installs a module in the registry from source.  The
    //> module is not immediately available. The `translate` and `instantiate`
    //> hooks are called asynchronously, and dependencies are loaded
    //> asynchronously.
    //>
    //> `define` returns a Promise object that resolves to undefined when the
    //> new module and its dependencies are installed in the registry.
    //>
    //> NOTE This is the dynamic equivalent of the proposed `<module name=>`
    //> element in HTML.
    //>
    define: function define(name, source, options = undefined) {
        //> 1.  Let loader be this Loader object.
        //> 1.  If loader does not have all the internal properties of a Loader
        //>     object, throw a TypeError exception.
        var loader = this;
        var loaderData = GetLoaderInternalData(this);

        //> 1.  Let name be ToString(name).
        //> 1.  ReturnIfAbrupt(name).
        name = ToString(name);

        let address = undefined;
        let metadata = undefined;
        //> 1.  If options is undefined then let options be the result of
        //>     calling ObjectCreate(%ObjectPrototype%, ()).
        if (options === undefined) {
            options = {};
        //> 1.  Else if Type(options) is not Object then throw a TypeError
        //>     exception.
        } else if (!IsObject(options)) {
            throw std_TypeError("options is not an object");
        }

        //> 1.  Let address be the result of calling the [[Get]] internal
        //>     method of options passing `"address"` as the argument.
        //> 1.  ReturnIfAbrupt(address).
        address = options.address;
        //> 1.  Let metadata be the result of calling the [[Get]] internal
        //>     method of options passing `"metadata"` as the argument.
        //> 1.  ReturnIfAbrupt(metadata).
        metadata = options.metadata;
        //> 1.  If metadata is undefined then let metadata be the result of
        //>     calling ObjectCreate(%ObjectPrototype%, ()).
        if (metadata === undefined)
            metadata = {};

        //> 1.  Let F be a new anonymous function object as defined in
        //>     AsyncStartLoadPartwayThrough.
        //> 1.  Set F.[[Loader]] to loader.
        //> 1.  Set F.[[ModuleName]] to name.
        //> 1.  Set F.[[Step]] to the String `"translate"`.
        //> 1.  Set F.[[ModuleMetadata]] to metadata.
        //> 1.  Set F.[[ModuleSource]] to source.
        //> 1.  Set F.[[ModuleAddress]] to address.
        var f = MakeClosure_AsyncStartLoadPartwayThrough(
            loader, loaderData, name, "translate", metadata, address, source);

        //> 1.  Return the result of calling OrdinaryConstruct(%Promise%, (F)).

        // Bug: This leaks the use of promises in the implementation, since the
        //      `Promise` constructor may have had its @@create mutated. We
        //      need a slightly better strategy for creating async logic in the
        //      spec.
        return new std_Promise(f);
    },
    //>
    //> The `length` property of the `define` method is **2**.
    //>


    //> #### Loader.prototype.load ( request, options = undefined )
    //>
    //> The `load` method installs a module into the registry by name.
    //>
    //> NOTE Combined with the `normalize` hook and `Loader.prototype.get`,
    //> this provides a close dynamic approximation of an ImportDeclaration.
    //>
    load: function load(name, options = undefined) {
        //> 1.  Let loader be this Loader object.
        //> 1.  If loader does not have all the internal properties of a Loader
        //>     object, throw a TypeError exception.
        var loader = this;
        GetLoaderInternalData(this);

        //> 1.  Let name be ToString(name).
        //> 1.  ReturnIfAbrupt(name).
        name = ToString(name);

        var address;
        //> 1.  If options is undefined, then
        if (options === undefined) {
            //>     1.  Let address be undefined.
            address = undefined;
        //> 1.  Else if Type(options) is Object then 
        } else if (IsObject(options)) {
            //>     1.  Let address be the result of calling the [[Get]] internal
            //>         method of options passing `"address"` as the argument.
            //>     1.  ReturnIfAbrupt(address).
            
            address = options.address;
        //> 1.  Else,
        } else {
            //>     1.  throw a TypeError exception.
            throw std_TypeError("options is not an object");
        }

        //> 1.  Let F be a new anonymous function object as defined in
        //>     AsyncStartLoadPartwayThrough.
        //> 1.  Set F.[[Loader]] to loader.
        //> 1.  Set F.[[ModuleName]] to name.
        //> 1.  Set F.[[Step]] to ???.
        //> 1.  Set F.[[ModuleMetadata]] to metadata.
        //> 1.  Set F.[[ModuleSource]] to source.
        //> 1.  Set F.[[ModuleAddress]] to address.
        var f = MakeClosure_AsyncStartLoadPartwayThrough(
            loader, loaderData, name,
            address === undefined ? "locate" : "fetch",
            metadata, address, undefined);

        //> 1.  Return the result of calling OrdinaryConstruct(%Promise%, (F)).
        return new std_Promise(f);
    },
    //>
    //> The `length` property of the `load` method is **1**.
    //>


    //> #### Loader.prototype.module ( source, options )
    //>
    //> The `module` method asynchronously evaluates a top-level, anonymous
    //> module from source.
    //>
    //> The module's dependencies, if any, are loaded and committed to the registry.
    //> The anonymous module itself is not added to the registry.
    //>
    //> `module` returns a Promise object that resolves to a new Module
    //> instance object once the given module body has been evaluated.
    //>
    //> NOTE This is the dynamic equivalent of an anonymous `<module>` in HTML.
    //>
    module: function module(source, options = undefined) {
        //> 1.  Let loader be this Loader object.
        //> 1.  If loader does not have all the internal properties of a Loader
        //>     object, throw a TypeError exception.
        var loader = this;
        GetLoaderInternalData(this);

        let address = undefined;
        //> 1.  If options is undefined then let options be the result of
        //>     calling ObjectCreate(%ObjectPrototype%, ()).
        if (options === undefined) {
            options = {};
        //> 1.  Else if Type(options) is not Object then throw a TypeError
        //>     exception.
        } else if (!IsObject(options)) {
            throw std_TypeError("options is not an object");
        }

        //> 1.  Let address be the result of calling the [[Get]] internal
        //>     method of options passing `"address"` as the argument.
        //> 1.  ReturnIfAbrupt(address).
        address = options.address;

        //> 1.  Let load be CreateLoad(undefined).
        let load = CreateLoad(undefined);

        //> 1.  Let linkSet be CreateLinkSet(loader, load).
        let linkSet = CreateLinkSet(loader, load);

        //> 1.  Let successCallback be a new anonymous function object as defined
        //>     by EvaluateLoadedModule.
        //> 1.  Set successCallback.[[Loader]] to loader.
        //> 1.  Set successCallback.[[Load]] to load.
        //> 1.  Let p be the result of calling the [[Call]] internal method of
        //>     %PromiseThen% passing linkSet.[[Done]] and (successCallback) as
        //>     arguments.
        let p = callFunction(std_Promise_then, linkSet.done,
                             MakeClosure_EvaluateLoadedModule(loader, load));

        //> 1.  Let sourcePromise be the result of calling the [[Call]]
        //>     internal  method of %PromiseFulfill% passing null and
        //>     (source) as arguments.
        var sourcePromise = std_Promise_fulfill(source);

        //> 1.  Call the ProceedToTranslate abstract operation passing loader, load,
        //>     and sourcePromise as arguments.
        ProceedToTranslate(loader, load, sourcePromise);

        return p;
    },
    //>
    //> The `length` property of the `module` method is **1**.
    //>


    //> #### Loader.prototype.import ( name, options )
    //>
    //> The `import` method asynchronously loads, links, and evaluates a module
    //> and all its dependencies.
    //>
    //> `import` returns a Promise that resolves to the requested `Module` object
    //> once it has been committed to the registry and evaluated.
    //>
    //> NOTE This is the dynamic equivalent (when combined with normalization)
    //> of an ImportDeclaration.
    //>
    import: function import_(name, options = undefined) {
        //> 1.  Let loader be this Loader object.
        //> 1.  If loader does not have all the internal properties of a Loader
        //>     object, throw a TypeError exception.
        var loader = this;
        var loaderData = GetLoaderInternalData(this);

        //> 1.  Let name be ToString(name).
        //> 1.  ReturnIfAbrupt(name).
        name = ToString(name);

        let address = undefined;
        //> 1.  If options is undefined then let options be the result of
        //>     calling ObjectCreate(%ObjectPrototype%, ()).
        if (options === undefined) {
            options = {};
        //> 1.  Else if Type(options) is not Object then throw a TypeError
        //>     exception.
        } else if (!IsObject(options)) {
            throw std_TypeError("options is not an object");
        }

        //> 1.  Let address be the result of calling the [[Get]] internal
        //>     method of options passing `"address"` as the argument.
        //> 1.  ReturnIfAbrupt(address).
        address = options.address;

        //> 1.  Let loadPromise be RequestLoad(loader, name, undefined, address).
        let loadPromise = RequestLoad(loader, name, undefined, address);

        //> 1.  Let G be a new anonymous function object as define in
        //>         AsyncLoadAndEvaluateModule.
        //> 1.  Let G.[[Loader]] be loader.
        //> 1.  Let p be the result of calling the [[Call]] internal method of
        //>     %PromiseThen% passing loadPromise and (G) as arguments.
        //> 1.  Return p.
        return callFunction(std_Promise_then, loadPromise,
                            MakeClosure_AsyncLoadAndEvaluateModule(loader));
    },
    //>
    //> The `length` property of the `import` method is **1**.
    //>


    //> #### Loader.prototype.eval ( source )
    //>
    //> The following steps are taken:
    //>
    eval: function(source) {
        //> 1.  Let loader be this Loader object.
        //> 1.  If Type(loader) is not Object or loader does not have all the
        //>     internal properties of a Loader object, throw a TypeError
        //>     exception.
        if (!IsObject(this) ||
            !callFunction(std_WeakMap_has, loaderInternalDataMap, this))
        {
            throw std_TypeError("not a Loader object");
        }

        let internalData = GetLoaderInternalData(this);

        //> 1.  Return the result of calling the IndirectEval abstract operation
        //>     passing loader.[[Realm]] and source as arguments.
        return $IndirectEval(internalData.realm, source);
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
        name = ToString(name);

        //> 5.  Repeat for each Record {[[key]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name, then
        //>         1.  Let module be p.[[value]].
        //>         2.  Let result be the result of EnsureEvaluated(module, (),
        //>             loader).
        //>         3.  ReturnIfAbrupt(result).
        //>         4.  Return p.[[value]].
        //> 6.  Return undefined.
        let m = callFunction(std_Map_get, loaderData.modules, name);
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
        name = ToString(name);

        //> 5.  Repeat for each Record {[[name]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name, then return true.
        //> 6.  Return false.
        return callFunction(std_Map_has, loaderData.modules, name);
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
            throw std_TypeError("Module object required");

        //> 6.  Repeat for each Record {[[name]], [[value]]} p that is an
        //>     element of loader.[[Modules]],
        //>     1.  If p.[[key]] is equal to name,
        //>         1.  Set p.[[value]] to module.
        //>         2.  Return loader.
        //> 7.  Let p be the Record {[[key]]: name, [[value]]: module}.
        //> 8.  Append p as the last record of loader.[[Modules]].
        //> 9.  Return loader.
        callFunction(std_Map_set, loaderData.modules, name, module);
        return this;
    },
    //>
    //
    // **The Module type check in set()** &ndash; If the module argument is not
    // actually a Module instance object, `set` fails. This enforces an
    // invariant of the module registry: all the values are `Module`
    // instances. *Rationale:* We use `Module`-specific operations on them,
    // particularly for linking and evaluation.
    //
    // **set() and already-linked modules** &ndash; If there is already a
    // module in the registry with the given full name, `set` replaces it, but
    // any scripts or modules that are linked to the old module remain linked
    // to it. *Rationale:* Re-linking already-linked modules might not work,
    // since the new module may export a different set of names. Also, the new
    // module may be linked to the old one! This is a convenient way to
    // monkeypatch modules. Once modules are widespread, this technique can be
    // used for polyfilling.
    //
    // **set() and concurrent loads** &ndash; If a Load Record for `name` is in
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
        return callFunction(std_Map_delete, loaderData.modules, name);
    },
    //>
    //
    // **delete() and concurrent loads** &ndash; Calling `.delete()` has no
    // immediate effect on in-flight loads, but it can cause such a load to
    // fail later.
    //
    // That's because the dependency-loading algorithm (above) assumes that if
    // it finds a module in the registry, it doesn't need to load that module.
    // If someone deletes that module from the registry (and doesn't replace it
    // with something compatible), then when loading finishes, it will find
    // that a module it was counting on has vanished.  Linking will fail.
    //
    // **delete() and already-linked modules** &ndash; `loader.delete("A")`
    // removes only `A` from the registry, and not other modules linked against
    // `A`, for several reasons:
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
        return new LoaderIterator(callFunction(std_Map_entries, loaderData.modules));
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
        return new LoaderIterator(callFunction(std_Map_keys, loaderData.modules));
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
        return new LoaderIterator(callFunction(std_Map_values, loaderData.modules));
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
    //> a time.  The module registry can contain at most one module for a given
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
    //> *When this hook is called:*  For all modules whose source is not
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
        throw std_TypeError("Loader.prototype.fetch was called");
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
    //> *When this hook is called:*  For all modules, including module bodies
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
    //>  3. The hook may return a factory object which the loader will use to
    //>     create the module and link it with its clients and dependencies.
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
//> 3.  Let iterator be the result of ObjectCreate(%LoaderIteratorPrototype%,
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
        return callFunction(std_Map_iterator_next, $GetLoaderIteratorPrivate(this));
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
