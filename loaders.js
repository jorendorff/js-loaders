/*
  loaders.js - pseudo-implementation of proposed ES6 module loaders

  *** Current status **********************************************************

  This is currently extremely incomplete.  The following are in decent shape:
    - the Loader constructor;
    - .eval(src, options);
    - .load(url, callback, errback);
    - .evalAsync(src, callback, errback, options);
    - .import(name, callback, errback, options);
    - .get(name), .has(name), .set(name, module), .delete(name);
    - .ondemand(sources);
    - the loader hooks and the loading pipeline that calls them;
    - execution order;
    - dependency loading;
    - linking.

  These things are not implemented at all yet:
    - the last bit of plumbing connecting the load pipeline back to the success
      and failure callbacks provided by load/evalAsync/import;
    - error handling when multiple module loads are involved;
    - support for custom link hooks that create dynamic-linked ("factory-made")
      modules;
    - the fetch hook's done() callback;
    - intrinsics;
    - probably various other odds and ends.


  *** About loaders ***********************************************************

  The module loader is implemented in three classes, only one of which is
  ever visible to scripts.

  Loader - The public class.  Its API is standard-track, but no detailed
    specification text has been written yet.  This implementation uses the
    following documents as a starting point:

    https://docs.google.com/document/d/1FL3VF_OEwMPQ1mZKjxgR-R-hkieyyZO-8Q_eNTiyNFs/edit#

    https://gist.github.com/wycats/51c96e3adcdb3a68cbc3

    In addition many details of the behavior have been pinned down in IRC
    conversations with Sam Tobin-Hochstadt and David Herman.

  LinkSet - Stores state for a particular call to loader.load(),
    .evalAsync(), or .import().

  LoadTask - Stores the status of a particular module from the time we
    first decide to load it until it is fully linked and ready to execute.


  TODO: Look up how "intrinsics" work and wire that through everything.

  TODO: implement #3, #14, #24
*/

"use strict";

import {
    // Embedding features
    $QueueTask,
    $Assert,

    // Capabilities that JS provides, but via methods that other code could
    // delete or replace
    $ToString,      // $ToString(v) === ES ToString algorithm ~= ("" + v)
    $Apply,         // $Apply(f, thisv, args) ~= thisv.apply(f, args)
    $Call,          // $Call(f, thisv, ...args) ~= thisv.call(f, ...args)
    $ObjectDefineProperty, // $ObjectDefineProperty(obj, p, desc) ~= Object.defineProperty(obj, p, desc)
    $ObjectKeys,    // $ObjectKeys(obj) ~= Object.keys(obj)
    $IsArray,       // $IsArray(v) ~= Array.isArray(v)
    $ArrayPush,     // $ArrayPush(arr, v) ~= Object.defineProperty(arr, arr.length, {configurable: true, enumerable: true, writable: true, value: v})
    $ArrayPop,      // $ArrayPop(arr) ~= arr.pop()
    $SetNew,        // $SetNew() ~= new Set
    $SetHas,        // $SetHas(set, v) ~= set.has(v)
    $SetAdd,        // $SetAdd(set, v) ~= set.add(v)
    $SetIterable    // for (v of $SetIterable(set)) ~= for (v of set)
    $MapNew,        // $MapNew() ~= new Map
    $MapHas,        // $MapHas(map, key) ~= map.has(key)
    $MapGet,        // $MapGet(map, key) ~= map.get(key)
    $MapSet,        // $MapSet(map, key, value) ~= map.set(key, value)
    $MapDelete,     // $MapDelete(map, key) ~= map.delete(key)
    $MapIterator,   // $MapIterator(map) ~= map[@@iterator]()
    $TypeError,     // $TypeError(msg) ~= new TypeError(msg)
    $SyntaxError,   // $SyntaxError(msg) ~= new SyntaxError(msg)

    // Modules and scripts
    $CodeHasExecuted,
    $CodeSetExecuted,
    $CodeExecute,
    $CodeGetLinkedModules,

    // Scripts
    $Compile,
    $LinkScript,
    $EvaluateScript,
    $ScriptDeclaredModuleNames,  // array of strings
    $ScriptGetDeclaredModule,  // (script, name) -> Module
    $ScriptImports,  // array of pairs, see comment in Loader.eval()

    // Globals
    $DefineBuiltins
} from "implementation-intrinsics";

/*
  A Loader is responsible for asynchronously finding, fetching, linking,
  and running modules and scripts.

  The major methods are:
      eval(src) - Synchronously run some code. Never loads modules,
          but src may import already-loaded modules.
      import(moduleName) - Asynchronously load a module and its
          dependencies.
      evalAsync(src, callback, errback) - Asynchronously run some code.
          Loads imported modules.
      load(url, callback, errback) - Asynchronously load and run a script.
          Loads imported modules.

  Each Loader has a module registry, which is a cache of already loaded and
  linked modules.  The Loader tries to avoid fetching modules multiple
  times, even when multiple load() calls need the same module before it is
  ready to be added to the registry.

  Loader hooks. The import process can be customized by assigning to (or
  subclassing and overriding) any number of the five loader hooks:
      normalize(name) - From a possibly relative module name, determine the
          full module name.
      resolve(fullName, options) - Given a full module name, determine the
          URL to load and whether we're loading a script or a module.
      fetch(url, fulfill, reject, skip, options) - Load a script or module
          from the given URL.
      translate(src, options) - Optionally translate a script or module
          from some other language to JS.
      link(src, options) - Determine dependencies of a module; optionally
          convert an AMD/npm/other module to an ES Module object.
*/
export class Loader {
    /*
      Create a new Loader.

      P3 ISSUE #10: Is the parent argument necessary?
    */
    constructor(parent, options) {
        /*
          this.@modules is the module registry.  It maps full module names
          to Module objects.

          This map only ever contains Module objects that have been fully
          linked.  However it can contain modules whose bodies have not yet
          started to execute.  Except in the case of cyclic imports, such
          modules are not exposed to user code without first calling
          Loader.@ensureExecuted().
        */
        this.@modules = $MapNew();

        /*
          this.@loading stores information about modules that are loading
          and not yet linked.  It maps module names to LoadTask objects.

          This is stored in the loader so that multiple calls to
          loader.load()/.import()/.evalAsync() can cooperate to fetch what
          they need only once.
        */
        this.@loading = $MapNew();

        /*
          Map from urls (strings) to module contents (string or Array of
          string). Updated by loader.ondemand().
        */
        this.@ondemand = $MapNew();

        /*
          Map from module names to urls, a cached index of the data in
          this.@ondemand.
        */
        this.@locations = undefined;

        /* Various options. */
        this.@global = options.global;  // P4 ISSUE: ToObject here?
        this.@strict = ToBoolean(options.strict);
        this.@baseURL = $ToString(options.baseURL);

        /*
          P4 ISSUE: DETAILED BEHAVIOR OF HOOKS

          As implemented here, hooks are just ordinary properties of the
          Loader object.  Default implementations are just ordinary methods
          of the Loader class. Loader subclasses can add methods with the
          appropriate names, and use super() to invoke the base-class
          behavior, and stuff will "just work".

          It's not clear that's the right design.  What's specified in the
          document right now is different: hooks are stored in internal
          properties, and the loader exposes getters for each hook.  Firing
          a hook takes it from the internal property.  In no circumstance
          does super work.
        */
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


    /* Configuration *****************************************************/

    /*
      Return the global object associated with this loader.
    */
    get global() {
        return this.@global;
    }

    /*
      Return the loader's strictness setting. If true, all code loaded by
      this loader is treated as strict-mode code.
    */
    get strict() {
        return this.@strict;
    }

    /*
      Get/set the base URL this loader uses for auto-mapping module names
      to URLs.
    */
    get baseURL() {
        return this.@baseURL;
    }

    set baseURL(url) {
        this.@baseURL = $ToString(url);
    }

    /*
      TODO: doc comment here

      P4 ISSUE:  Proposed name for this method: addSources(sources)
    */
    ondemand(sources) {
        let keys = $ObjectKeys(sources);
        for (let i = 0; i < keys.length; i++) {
            let url = keys[i];
            let contents = sources[url];
            if (contents === null) {
                $MapDelete(this.@ondemand, url);
            } else if (typeof contents === "string") {
                $MapSet(this.@ondemand, url, contents);
            } else {
                /*
                  contents must be either null, a string, or an iterable object.

                  Rationale for making a copy of contents rather than
                  keeping the object around: Determinism, exposing fewer
                  implementation details.  Examining a JS object can run
                  arbitrary code.  We want to fire all those hooks now,
                  then store the data in a safer form so user code can't
                  observe when we look at it.

                  P4 ISSUE: confirm iterable vs. array.
                */
                let names = [];
                for (let name of contents) {
                    if (typeof name !== "string")
                        throw $TypeError("ondemand: module names must be strings");
                    $ArrayPush(names, name);
                }
                $MapSet(this.@ondemand, url, names);
            }
        }

        // Destroy the reverse cache.
        this.@locations = undefined;
    }


    /* Loading and running code ******************************************/

    /*
      Walk the dependency graph of the module or script `start`, executing all
      module bodies that have not executed.

      `start` and its dependencies must already be linked.

      On success, `start` and all its dependencies, transitively, will have
      started to execute exactly once.  That is, the $CodeHasExecuted bit is
      set on all of them.

      Execution order:  Dependencies are executed in depth-first, left-to-right,
      post order, stopping at cycles.  A script that contains one or more
      dependencies is executed immediately after the last of the modules it
      declares that are in the dependency set (per dherman, 2013 May 21).

      Error handling:  Module bodies can throw exceptions, and they are
      propagated to the caller.  The $CodeHasExecuted bit remains set on a
      module after its body throws an exception.

      Purpose:  Module bodies are executed on demand, as late as possible.
      The loader always calls this function before returning a module to
      script.

      There is only one way a module can be exposed to script before it has
      executed.  In the case of an import cycle, @ensureExecuted itself exposes
      the modules in the cycle to scripts before they have all executed.  This
      is a consequence of the simple fact that we have to start somewhere: one
      of the modules in the cycle must run first.
      
      P3 ISSUE: If you eval() or load() a script S that declares a module M and
      imports a module K, and executing K's body throws, then the next script
      that imports M will cause the body of S to execute. Super weird.
    */
    static @ensureExecuted(mod) {
        /*
          NOTE: A tricky test case for this code:

          <script>
            var ok = false;
          </script>
          <script>
            module "x" { import "y" as y; throw fit; }
            module "y" { import "x" as x; ok = true; }
            import "y" as y;  // marks "x" as executed, but not "y"
          </script>
          <script>
            import "x" as x;  // must execute "y" but not "x"
            assert(ok === true);
          </script>

          This is tricky because when we go to run the last script,
          module "x" is already marked as executed, but one of its
          dependencies, "y", isn't. We must find it anyway and execute it.

          Cyclic imports, combined with exceptions during module execution
          interrupting this algorithm, are the culprit.

          The remedy:  when walking the dependency graph, do not stop at
          already-marked-executed modules.  Implementations may optimize as
          noted below.
        */

        /*
          Another test case:

          var log = "";
          module "x" { import "y" as y; log += "x"; }
          module "y" { log += "y"; }
          import "x" as x, "y" as y;
          assert(log === "xy");
        */

        /*
          Error handling:  Suppose a module is linked, we start executing
          its body, and that throws an exception.  We leave it in the
          module registry (per samth, 2013 April 16) because re-loading the
          module and running it again is not likely to make things better.

          Other fully linked modules in the same LinkSet are also left in
          the registry (per dherman, 2013 April 18).  Some of those may be
          unrelated to the module that threw.  Since their "has ever
          started executing" bit is not yet set, they will be executed on
          demand.  This allows unrelated modules to finish loading and
          initializing successfully, if they are needed.

          One consequence of this design is that while executing a module
          body, calling eval() or System.get() can cause other module
          bodies to execute.  That is, module body execution can nest.
          However no individual module's body will be executed more than
          once.
        */

        /*
          Depth-first walk of the dependency graph, stopping at cycles, and
          executing each module body that has not already been executed (in
          post order).

          An implementation can optimize this by marking each module with
          an extra "no need to walk this subtree" bit when all
          dependencies, transitively, are found to have been executed.
        */
        let seen = $SetNew();
        let schedule = $SetNew();

        function walk(m) {
            $SetAdd(seen, m);
            let deps = $CodeGetLinkedModules(mod);
            for (let i = 0; i < deps.length; i++) {
                let dep = deps[i];
                if (!$SetHas(seen, dep))
                    walk(dep);
            }
            $SetAdd(schedule, m);

            if ($IsModule(m)) {
                // The $SetRemove call below means that if we already plan to
                // execute this script, move it to execute after m.
                let script = $ModuleGetContainingScript(m);
                $SetRemove(schedule, script);
                $SetAdd(schedule, script);
            }
        }

        walk(start);

        let result;
        for (let c of $SetIterable(schedule)) {
            if (!$CodeHasExecuted(c)) {
                $CodeSetExecuted(c);
                result = $CodeExecute(c);
            }
        }
        return result;
    }

    /*
      Check to see if script declares any modules that are already loaded
      or loading.  If so, throw a SyntaxError.  If not, add entries to the
      @loading map for each declared module.

      Rationale: Consider two evalAsync calls.

          System.evalAsync('module "x" { import "y" as y; }', ok, err);
          System.evalAsync('module "x" { import "z" as z; }', ok, err);

      It seemed perverse to let them race trying to load "y" and "z" after
      we know one of the two module "x" declarations must fail.  Instead,
      the second evalAsync fails immediately.  Per meeting, 2013 April 26.
    */
    @checkModuleDeclarations(script, loadTask) {
        // TODO - Unify this with very similar code in LoadTask.finish()
        // and LinkSet.link().
        let declared = $ScriptDeclaredModuleNames(script);
        for (let i = 0; i < declared.length; i++) {
            let fullName = declared[i];
            if ($MapHas(this.@modules, fullName)) {
                throw $SyntaxError("script declares module \"" + fullName + "\", " +
                                   "which is already loaded");
            }
            let pendingLoad = $MapGet(this.@loading, fullName);
            if (pendingLoad === undefined) {
                if (loadTask === null)
                    loadTask = new LoadTask(declared, script);
                $MapSet(this.@loading, fullName, loadTask);
            } else if (pendingLoad !== loadTask) {
                throw $SyntaxError("script declares module \"" + fullName + "\", " +
                                   "which is already loading");
            }
        }
    }

    /*
      Execute the program src.

      src may import modules, but if it imports a module that is not
      already in this loader's module registry, a SyntaxError is thrown.

      options.url is used as the script's filename.  (This may be used in
      Error objects thrown while executing the program, and it may appear
      in debugging tools.)

      Loader hooks:  This calls only the translate hook.  per samth,
      2013 April 22.  See rationale in the comment for evalAsync().

      P5 SECURITY ISSUE: This will allow Web content to run JS code that
      appears (in the devtools, for example) to be from any arbitrary URL.
      We might be able to constrain this to only same-domain URLs or
      something.  But ideally that filename just doesn't matter.  It
      certainly shouldn't matter to any code; code really shouldn't be
      looking at Error().stack or Error().fileName for security purposes!

      P4 ISSUE:  What about letting the user set the line number?
      samth is receptive.  2013 April 22.

      NOTE:  The google doc mentions another option, options.module, which
      would be a string and would cause all imports to be normalized
      relative to that module name.  per samth, 2013 April 22.  jorendorff
      objected to this feature and it is not presently implemented.

      P2 ISSUE: #8: Does global.eval go through the translate hook?
    */
    eval(src, options) {
        // Unpack options. Only one option is supported: options.url.
        let url = this.@baseURL;  // P4 ISSUE: is baseURL the right default?
        if (options !== undefined && "url" in options) {
            url = options.url;
            if (typeof url !== "string")
                throw $TypeError("eval: options.url must be a string");
        }

        let script = $Compile(this, src, null, url, this.@strict);
        this.@checkModuleDeclarations(script, null);

        /*
          $ScriptImports returns an array of [client, request] pairs.

          client tells where the import appears. It is the full name of the
          enclosing module, or null for toplevel imports.

          request is the name being imported.  It is not necessarily a full
          name, so we call the normalize hook below.
        */
        let pairs = $ScriptImports(script);

        /*
          Linking precedes execution. The code below completely finishes
          linking `scripts` with its dependencies before executing any of them.
        */
        let modules = [];
        for (let i = 0; i < pairs.length; i++) {
            let [client, request] = pairs[i];
            let referer = {name: client, url: url};
            let name = this.normalize(request, {referer});

            let m = $MapGet(this.@modules, name);
            if (m === undefined) {
                // The module is not in the registry. Perhaps it is
                // declared in this script.
                m = $ScriptGetDeclaredModule(script, name);

                /*
                  Rationale for throwing a SyntaxError: SyntaxError is
                  already used for a few conditions that can be detected
                  statically (before a script begins to execute) but are
                  not really syntax errors per se.  Reusing it seems
                  better than inventing a new Error subclass.
                */
                if (m === undefined)
                    throw $SyntaxError("eval: module not loaded: " + name);
            }
            $ArrayPush(modules, m);
        }

        /*
          The modules are already linked.  Now link the script.  Since
          this can throw a link error, it is observable that this happens
          before dependencies are executed below.
        */
        $LinkScript(script, modules);

        /* Commit declared modules to the registry. */
        let declared = $ScriptDeclaredModuleNames(script);
        for (let i = 0; i < declared.length; i++) {
            let fullName = declared[i];
            let m = $ScriptGetDeclaredModule(script, fullName);
            $MapDelete(this.@loading, fullName);
            $MapSet(this.@modules, fullName, m);
        }

        /*
          Execute any module bodies that have not been executed yet, then
          execute script.  Any script or module body can throw.

          Loader.@ensureExecuted() can execute other module bodies in the
          graph, to ensure that barring cycles, a module is always executed
          before other modules that depend on it.
        */
        return Loader.@ensureExecuted(script);
    }

    /*
      Asynchronously evaluate the program `src`.

      src may import modules that have not been loaded yet.  In that case,
      load all those modules, and their imports, transitively, before
      evaluating the script.

      On success, the result of evaluating the program is passed to
      `callback`.

      About callback and errback:
        Loader.prototype.evalAsync(), .load(), and .import() all take two
        callback arguments, callback and errback, the success and failure
        callbacks respectively.

        On success, these methods each schedule the success callback to be
        called with a single argument (the result of the operation).

        These three methods never throw. Instead, on error, the exception
        is stored until the next event loop turn and then passed to the
        failure callback.

        Both arguments are optional.  The default success callback does
        nothing.  The default failure callback throws its argument.
        (Rationale:  the event loop will then treat it like any other
        unhandled exception.)

        Success and failure callbacks are always called in a fresh event
        loop turn.  This means they will not be called until after
        evalAsync returns, and they are always called directly from the
        event loop:  except in the case of nested event loops, these
        callbacks are never called while user code is on the stack.

      options.url, if present, is passed to each loader hook, for each
      module loaded, as options.referer.url.  (The default loader hooks
      ignore it, though.)

      (options.url may also be stored in the script and used for
      Error().fileName, Error().stack, and the debugger, and we anticipate
      doing so via $Compile; but such use is outside the scope of the
      language standard.)

      (options.module is being specified, to serve an analogous purpose for
      normalization, but it is not implemented here. See the comment on
      eval().)

      Loader hooks:  For the script `src`, the normalize, resolve, fetch,
      and link hooks are not called.  The fetch hook is for obtaining code,
      which we already have, and the other three operate only on modules,
      not scripts.  It is not yet decided whether the translate hook is
      called; see the ISSUE comment on the eval method.  Of course for
      modules imported by `src` that are not already loaded, all the loader
      hooks can be called.

      Future directions:  evalAsync, import, load, and the fetch hook all
      take callbacks and currently return undefined.  They are designed to be
      upwards-compatible to Futures.  per samth, 2013 April 22.
    */
    evalAsync(src,
              callback = value => undefined,
              errback = exc => { throw exc; },
              options = undefined)
    {
        let url = undefined;
        if ("url" in options) {
            url = options.url;
            if (url !== undefined && typeof url !== "string")
                throw $TypeError("options.url must be a string or undefined");
        }

        return this.@evalAsync(src, callback, errback, url);
    }

    /*
      Shared implementation of evalAsync() and the post-fetch part of
      load().
    */
    @evalAsync(src, callback, errback, srcurl) {
        // Compile and check the script.
        let script;
        try {
            script = $Compile(this, code, null, srcurl, this.@strict);
            this.@checkModuleDeclarations(script, null);
        } catch (exc) {
            AsyncCall(errback, exc);
            return;
        }

        // Arrange for any dependencies to be loaded and linked with
        // script.  Once the script is linked, the LinkSet will call the
        // run() function below.
        let loaded = new LoadTask(script);
        let linkSet = new LinkSet(this, loaded, run, errback);

        function run() {
            /*
              Tail calls would be equivalent to AsyncCall, except for
              possibly some imponderable timing details.  This is meant as
              a reference implementation, so we just literal-mindedly do
              what the spec is expected to say.
            */
            let result;
            try {
                result = Loader.@ensureExecuted(script);
            } catch (exc) {
                AsyncCall(errback, exc);
                return;
            }
            AsyncCall(callback, result);
        }

        /*
          P4 ISSUE: Execution order when multiple LinkSets become linkable
          at once.

          Proposed: When a fetch fulfill callback fires and completes the
          dependency graph of multiple link sets at once, they are
          linked and executed in the order of the original
          load()/evalAsync() calls.

          samth is unsure but thinks probably so.
        */
    }

    /*
      Asynchronously load and run a script.  If the script contains import
      declarations, this can cause modules to be loaded, linked, and
      executed.

      On success, the result of evaluating the script is passed to the
      success callback.

      See the comment on asyncEval() for more about callback and errback.

      If options is not undefined and options.url is not undefined, then
      options.url is passed to the loader hooks as options.referer.url.
      (The default loader hook implementations ignore options.referer.)
    */
    load(url,
         callback = value => undefined,
         errback = exc => { throw exc; },
         options = undefined)
    {
        /*
          This method only does two things.

          1. Call the fetch hook to load the script from the given url.

          2. Once we get the source code, pass it to @evalAsync() which
             does the rest.  (Implementation issue: This reuse causes a
             single extra turn of the event loop which we could eliminate;
             not sure how visible it would be from a spec perspective.)
        */

        let referer = null;
        if (options !== undefined && "url" in options) {
            let url = options.url;
            if (url !== undefined) {
                if (typeof url !== "string") {
                    let msg = "load: options.url must be a string or undefined";
                    AsyncCall(errback, $TypeError(msg));
                    return;
                }
                referer = {name: null, url: url};
            }
        }

        /*
          P4 ISSUE: Check callability of callbacks here (and everywhere
          success/failure callbacks are provided)?  It would be a mercy,
          since the TypeError if they are not functions happens much later
          and with an empty stack.  But Futures don't do it.  Assuming no.

          if (typeof callback !== "function")
              throw $TypeError("Loader.load: callback must be a function");
          if (typeof errback !== "function")
              throw $TypeError("Loader.load: error callback must be a function");
        */

        /*
          Rationale for creating an empty object for metadata: The
          normalize hook only makes sense for modules; load() loads
          scripts.  But we do want load() to use the fetch hook, which
          means we must come up with a metadata value of some kind
          (this is ordinarily the normalize hook's responsibility).

          `metadata` is created using the intrinsics of the enclosing
          loader class, not the Loader's intrinsics, because it is for the
          loader hooks to use. It is never exposed to code loaded by this
          Loader.
        */
        let metadata = {};

        /*
          Rationale for fetchCompleted: The fetch hook is user code.
          Callbacks the Loader passes to it are subject to every variety of
          misuse; the system must be robust against these hooks being
          called multiple times.

          Futures treat extra resolve() calls after the first as no-ops; we
          throw instead, per meeting 2013 April 26.

          P5 ISSUE: what kind of error to throw when that happens (assuming
          TypeError).
        */
        let fetchCompleted = false;

        /*
          Note that the fetch hook may call fulfill() and the other hooks
          synchronously; see comment on fetch().
        */
        function fulfill(src, actualAddress) {
            if (fetchCompleted)
                throw $TypeError("load() fulfill callback: fetch already completed");
            fetchCompleted = true;

            if (typeof src !== "string") {
                let msg = "load() fulfill callback: first argument must be a string";
                AsyncCall(errback, $TypeError(msg));
            }
            if (typeof actualAddress !== "string") {
                let msg = "load() fulfill callback: third argument must be a string";
                AsyncCall(errback, $TypeError(msg));
            }

            this.@evalAsync(src, callback, errback, actualAddress);
        }

        function reject(exc) {
            if (fetchCompleted)
                throw $TypeError("load() reject callback: fetch already completed");
            fetchCompleted = true;

            AsyncCall(errback, exc);
        }

        function done() {
            if (fetchCompleted)
                throw $TypeError("load() done callback: fetch already completed");
            fetchCompleted = true;

            /* P5 ISSUE: what kind of error to throw here. */
            let msg = "load(): fetch hook must not call done() callback";
            AsyncCall(errback, $TypeError(msg));
        }

        let fetchOptions = {
            referer: referer,
            metadata: metadata,
            normalized: null,
            type: "script"
        };

        try {
            this.fetch(null, fulfill, reject, done, fetchOptions);
        } catch (exc) {
            /*
              Some care is taken here to prevent even a badly-behaved fetch
              hook from causing errback() to be called twice or not to be
              called at all.
            */
            if (fetchCompleted)
                AsyncCall(() => { throw exc; });
            else
                reject(exc);
        }
    }

    /*
      Asynchronously load, link, and execute a module and any dependencies
      it imports.  On success, pass the Module object to the success
      callback.

      See the comment on asyncEval() for more about callback and errback.
    */
    import(moduleName,
           callback = () => undefined,
           errback = exc => { throw exc; },
           options = undefined)
    {
        // Build referer.
        let name = null, url = this.@baseURL;
        if (options !== undefined) {
            if ("module" in options) {
                name = options.module;
                if (typeof name !== "string")
                    throw $TypeError("import: options.module must be a string");
            }
            if ("url" in options) {
                url = options.url;
                if (typeof url !== "string")
                    throw $TypeError("import: options.url must be a string");
            }
        }
        let referer = {name, url};

        // this.@import starts us along the pipeline.
        let fullName;
        try {
            fullName = this.@import(referer, moduleName);
        } catch (exc) {
            AsyncCall(errback, exc);
            return;
        }

        let m = $MapGet(this.@modules, fullName);
        if (m !== undefined) {
            // We already had this module in the registry.
            AsyncCall(success, m);
        } else {
            // The module is now loading.  When it loads, it may have more
            // imports, requiring further loads, so put it in a LinkSet.
            let load = $MapGet(this.@loading, fullName);
            let linkSet = new LinkSet(this, load, success, errback);
        }

        let success = () => {
            let m = $MapGet(this.@modules, fullName); // TODO: file an issue; David wants to get rid of this
            try {
                if (m === undefined) {
                    throw $TypeError("import(): module \"" + fullName +
                                     "\" was deleted from the loader");
                }
                Loader.@ensureExecuted(m);
            } catch (exc) {
                return errback(exc);
            }
            return callback(m);
        };
    }

    /*
      The common implementation of the import() method and the processing
      of import declarations in ES code.

      There are several possible outcomes:

      1.  Getting this.normalize throws, or the normalize hook isn't
          callable, or it throws an exception, or it returns an invalid
          value.  In these cases, @import throws.

      2.  The normalize hook returns the name of a module that is already
          in the registry.  @import returns the normalized name.

      3.  In all other cases, either a new LoadTask is started or we can
          join one already in flight.  @import returns the normalized name.

      referer provides information about the context of the import() call
      or import-declaration.  This information is passed to all the loader
      hooks.

      name is the (pre-normalize) name of the module to be imported, as it
      appears in the import-declaration or as the argument to
      loader.import().

      TODO:  Suggest alternative name for referer.  It is really nothing to
      do with the nasty Referer HTTP header.  Perhaps "importContext",
      "importer", "client".
    */
    @import(referer, name) {
        /*
          Call the normalize hook to get a normalized module name and
          metadata.  See the comment on normalize().

          Errors that happen during this step propagate to the caller.
        */
        let normalized, metadata;
        {
            /*
              P4 ISSUE: Here referer is passed to the normalize hook and
              later it is passed to the resolve hook, and so on.  Should we
              create a new object each time?  (I think it's OK to pass the
              same referer object to successive hooks within a single load;
              but eval() creates a new referer object for each call to the
              normalize() hook, since they are not abstractly all part of a
              single load.)
            */
            let result = this.normalize(request, {referer});

            /*
              Interpret the value returned by the normalize hook.

              It must a string or an object with a .normalized property
              whose value is a string.  Otherwise a TypeError is thrown.
              per samth, 2013 April 22, and issue #13.
            */
            if (typeof result === "string") {
                normalized = result;
                metadata = {};
            } else if (!IsObject(result)) {
                /*
                  The result is null, a boolean, a number, or (if symbols
                  somehow get defined as primitives) a symbol. Throw.

                  Rationale: Both a string and an object are possibly valid
                  return values. We could use ToString or ToObject to
                  coerce this value. But neither is the slightest bit
                  compelling or useful. So throw instead.
                */
                throw $TypeError(
                    "Loader.normalize hook must return undefined, " +
                    "a string, or an object");
            } else {
                /*
                  Several hooks, including the normalize hook, may return
                  multiple values, by returning an object where several
                  properties are significant.  In all these cases, the
                  object is just a temporary record.  The loader
                  immediately gets the data it wants out of the returned
                  object and then discards it.

                  In this case, we care about two properties on the
                  returned object, .normalized and .metadata, but only
                  .normalized is required.
                */

                if (!("normalized" in result)) {
                    throw $TypeError(
                        "Result of loader.normalize hook must be undefined, a string, or " +
                        "an object with a .normalized property");
                }

                normalized = result.normalized;  // can throw

                // Do not use $ToString here, per samth, 2013 April 22.
                if (typeof normalized !== "string") {
                    throw $TypeError(
                        "Object returned by loader.normalize hook must have " +
                        "a string .normalized property");
                }

                metadata = result.metadata;  // can throw
            }
        }

        // From this point @import cannot throw.

        // If the module has already been loaded and linked, we are done.
        if ($MapHas(this.@modules, normalized)) {
            // P3 ISSUE #12:  Loader hooks can't always detect pipeline exit.
            return normalized;
        }

        // If the module is already loading, we are done.
        if ($MapHas(this.@loading, normalized))
            return normalized;

        /*
          Create a LoadTask object for this module load.  Once this object
          is in this.@loading, LinkSets may add themselves to its set of
          waiting link sets. Errors must be reported to loadTask.fail().
        */
        let loadTask = new LoadTask([normalized]);
        $MapSet(this.@loading, normalized, loadTask);

        let url, type;
        try {
            // Call the resolve hook.
            let result = this.resolve(normalized, {referer, metadata});

            // Interpret the result.
            type = "module";
            if (typeof result === "string") {
                url = result;
            } else if (IsObject(result)) {
                // result.url must be present and must be a string.
                if (!("url" in result)) {
                    throw $TypeError("Object returned from loader.resolve hook " +
                                     "must have a .url property");
                }
                url = result.url;
                if (typeof url !== "string") {
                    throw $TypeError(".url property of object returned from " +
                                     "loader.resolve hook must be a string");
                }

                /*
                  result.extra is optional, but if present must be an
                  iterable object, a collection of module names. It
                  indicates that the resource at result.url is a script
                  containing those modules.  (The module we're loading,
                  named by normalized, may be present in result.extra or
                  not.)

                  This means the loader can merge the following imports in
                  a single load:

                      import "a" as a, "b" as b;

                  if it knows in advance a URL that contains module
                  declarations for both "a" and "b".
                */
                if ("extra" in result) {
                    let extra = result.extra;
                    if (!IsObject(extra)) {
                        throw $TypeError(
                            ".extra property of object returned from " +
                            "loader.resolve hook must be an object");
                    }

                    /* P4 ISSUE: confirm iterable rather than array */
                    let names = [...extra];

                    for (let i = 0; i < names.length; i++) {
                        let name = names[i];
                        if (typeof name !== "string")
                            throw $TypeError("module names must be strings");
                        if (name !== normalized &&
                            ($MapHas(this.@modules, name)
                             || $MapHas(this.@loading, name))) {
                            throw $TypeError(
                                "loader.resolve hook claims module \"" +
                                name + "\" is at <" + url + "> but " +
                                "it is already loaded");
                        }
                    }

                    /*
                      Record a load in progress for all other modules
                      defined in the same script.
                    */
                    for (let i = 0; i < names.length; i++) {
                        let fullName = names[i];
                        if (fullName !== normalized) {
                            ???;
                            $MapSet(this.@loading, fullName, loadTask);
                        }
                    }

                    type = "script";
                }
            } else {
                throw $TypeError("loader.resolve hook must return a " +
                                 "string or an object with .url");
            }
        } catch (exc) {
            /*
              Implementation issue:  This isn't implemented yet, but
              loadTask.fail() will be responsible for forwarding this error
              to all LinkSets that have attached to loadTask in the
              meantime.  It is also responsible for removing loadTask
              itself from this.@loading.
            */
            loadTask.fail(exc);
            return normalized;
        }

        loadTask.type = type;

        // Prepare to call the fetch hook.
        let fetchCompleted = false;
        let thisLoader = this;

        function fulfill(src, actualAddress) {
            if (fetchCompleted)
                throw $TypeError("fetch fulfill callback: fetch already completed");
            fetchCompleted = true;

            return thisLoader.@onFulfill(loadTask, normalized, metadata, type,
                                         src, actualAddress);
        }

        function reject(exc) {
            if (fetchCompleted)
                throw $TypeError("fetch reject callback: fetch already completed");
            fetchCompleted = true;

            return loadTask.fail(exc);
        }

        /*
          P1 ISSUE #3: Agree on a design for done() hook; get use
          cases/rationale for done() hook.
          https://github.com/jorendorff/js-loaders/issues/3
        */
        function done() {
            if (fetchCompleted)
                throw $TypeError("fetch done callback: fetch already completed");
            fetchCompleted = true;

            let mod = $MapGet(this.@modules, normalized);
            if (mod === undefined) {
                let msg = "fetch hook done() callback: " +
                    "not actually done loading \"" + normalized + "\"";
                loadTask.fail($TypeError(msg));
            }
            loadTask.onEndRun(normalized, mod);
        }

        // P3 ISSUE: type makes sense here, yes?
        // P3 ISSUE: what about "extra"?
        let options = {referer, metadata, normalized, type};

        // Call the fetch hook.
        try {
            this.fetch(url, fulfill, reject, done, options);
        } catch (exc) {
            /*
              As in load(), take care that loadTask.fail is called if the
              fetch hook fails, but at most once.
            */
            if (fetchCompleted)
                AsyncCall(() => { throw exc; });
            else
                loadTask.fail(exc);
        }

        return normalized;
    }

    @onFulfill(loadTask, normalized, metadata, type, src, actualAddress) {
        try {
            // Check arguments to fulfill hook.
            if (typeof src !== "string") {
                throw $TypeError("fetch hook fulfill callback: " +
                                 "first argument must be a string");
            }
            if (typeof actualAddress !== "string") {
                throw $TypeError("fetch hook fulfill callback: " +
                                 "second argument must be a string");
            }

            // Call translate and link hooks.
            src = this.translate(src, {normalized, actualAddress, metadata, type});
            if (typeof src !== "string")
                throw $TypeError("translate hook must return a string");
            let linkResult = this.link(src, {normalized, actualAddress, metadata, type});

            // Interpret linkResult.  See comment on the link() method.
            if (linkResult === undefined) {
                let script = $Compile(this, src, normalized, actualAddress, this.@strict);
                loadTask.finish(this, actualAddress, script);
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
                loadTask.onEndRun(normalized, mod);
            } else {
                let mod = null;
                let imports = linkResult.imports;

                /* P4 issue: "iterable" vs. "array" */
                if (imports !== undefined)
                    imports = [...imports];
                let exports = [...linkResult.exports];
                let execute = linkResult.execute;

                throw TODO;
            }
        } catch (exc) {
            loadTask.fail(exc);
        }
    }

    /* Module registry ***************************************************/

    /*
      Get a module by name from this loader's module registry.

      If no module with the given name is in the module registry, return
      undefined.  The argument `name` is the full name.

      If the module is in the registry but has never been executed, first
      synchronously execute the module and any dependencies that have not
      been executed yet.

      Throw a TypeError if name is not a string. If it is a string but
      not a valid full name for a module (e.g. "../x" or "@@@@"), return
      undefined.  per samth, 2013 April 22.
    */
    get(name) {
        if (typeof name !== "string")
            throw $TypeError("module name must be a string");

        let m = $MapGet(this.@modules, name);
        if (m !== undefined)
            Loader.@ensureExecuted(m);
        return m;
    }

    /*
      Return true if a module with the given full name is in this Loader's
      module registry.

      This does not fire any loader hooks.  Throw a TypeError if name is not
      a string.  If it is a string but not a valid full name for a module,
      return false.
    */
    has(name) {
        if (typeof name !== "string")
            throw $TypeError("module name must be a string");

        return $MapHas(this.@modules, name);
    }

    /*
      Place a module in the module registry.

      If there is already a module in the registry with the given full
      name, replace it, but any other modules linked to that module remain
      linked to it. (Rationale: this is the way to monkeypatch modules
      provided by the browser and add features, even though every Module
      has a fixed set of exported names.)

      Throws a TypeError if name is not a string, if name is not a valid
      full name for a module (e.g. "../x" or "@@@@"), or if mod is not
      a Module object.

      Return this loader.
    */
    set(name, mod) {
        if (typeof name !== "string")
            throw $TypeError("module name must be a string");

        if (!$IsModule(mod)) {
            /*
              Rationale: Entries in the module registry must actually be
              Modules.  We do Module-specific operations like
              $CodeGetLinkedModules, $CodeHasExecuted, and $CodeExecute on
              them.  The spec will do the same.  per samth, 2013 April 22.
            */
            throw $TypeError("Module object required");
        }

        /*
          If name is in this.@loading, this succeeds, with no immediate
          effect on the pending load; but if that load eventually produces
          a module-declaration for the same name, that will produce a
          link-time error. per samth, 2013 April 22.
        */

        $MapSet(this.@modules, name, mod);
        return this;
    }

    /*
      Synchronously remove a module instance from the module registry.
      If there is no module with the given full name in the registry, do
      nothing.

      Throw a TypeError if name is not a string.  If it is a string but not
      a valid full name for a module, do nothing.

      Return this loader.

      loader.delete("A") has no effect at all if !loader.@modules.has("A"),
      even if "A" is currently loading (an entry exists in
      loader.@loading).  This is analogous to .set().  per (reading between
      the lines) discussions with dherman, 2013 April 17, and samth, 2013
      April 22.

      Effects on concurrent loads:  A delete has no immediate effect on
      in-flight loads, but it can cause a load to fail later.  Here's how
      it works:

      - During load phase, whenever we find new code that imports a module,
        we first look in the registry for that module, and failing that,
        the table of in-flight loads.  If it is not in either table, we
        start a fresh load.  There is no per-LinkSet state to prevent us
        from kicking off many loads for the same module during a single
        load phase; in the case of cyclic imports, if someone keeps
        deleting the successfully-loaded modules from the registry, we
        could go on indefinitely.

      - After a succesful load phase, when all fetches, translate hooks,
        link hooks, and compiles have finished successfully, we move on to
        link phase.  We walk the graph again, starting from the root, and
        try to link all the not-yet-linked modules, looking up every
        imported module in the registry as we go.  If at this point we find
        that a module we need is no longer in the registry, that's a link
        error.

      per samth, 2013 April 22.

      Containment: loader.delete("A") removes only "A" from the registry,
      and not other modules linked against "A", for several reasons:

      1. What a module is linked against is properly an implementation
         detail, which the "remove everything" behavior would leak.

      2. The transitive closure of what is linked against what is
         potentially a lot of stuff.

      3. Some uses of modules -- in particular polyfilling -- involve
         defining a new module MyX, linking it against some busted built-in
         module X, then replacing X in the registry with MyX. So having
         multiple "versions" of a module linked together is a feature, not
         a bug.

      per samth, 2013 April 16.
    */
    delete(name) {
        $MapDelete(this.@modules, name);
        return this;
    }

    /*
      Define all the built-in objects and functions of the ES6 standard
      library associated with this loader’s intrinsics as properties on
      obj.
    */
    defineBuiltins(obj = this.@global) {
        $DefineBuiltins(obj, this);
        return obj;
    }


    /* Loader hooks ******************************************************/

    // TODO these methods need to check the this-value carefully.  This can
    // be done with a private symbol.

    /*
      For each import() call or import-declaration, the Loader first calls
      loader.normalize(name, options) passing the module name as passed to
      import() or as written in the import-declaration.  This hook returns
      a full module name which is used for the rest of the import process.
      (In particular, modules are stored in the registry under their full
      module name.)

      When the normalize hook is called:  For all imports, including
      imports in scripts.  It is not called for the main script body
      executed by a call to loader.load(), .eval(), or .evalAsync().

      After calling this hook, if the full module name is in the registry,
      loading stops. Otherwise loading continues, calling the resolve()
      hook.

      The normalize hook may also create a custom metadata value that will
      be passed automatically to the other hooks in the pipeline.

      The default implementation does nothing and returns the module name
      unchanged.

      Returns one of:
        - a string s, the full module name.  The loader will create a new
          empty Object to serve as the metadata object for the rest of the
          load; OR

        - undefined, equivalent to returning `name` unchanged; OR

        - an object that has a .normalized property that is a string, the
          full module name.
    */
    normalize(name, options) {
        return name;
    }

    /*
      Determine the resource address (URL, path, etc.) for the requested
      module name.

      The resolve hook is also responsible for determining whether the
      resource in question is a module or a script.

      The hook may return:

        - undefined, to request the default behavior described below.
          (P1 ISSUE #13: Define behavior when the resolve hook returns
          undefined.)

        - a string, the resource address. In this case the resource is a
          module.

        - an object that has a .address property which is a string, the
          resource address.  The object may also have a .type property,
          which if present must be either "script" or "module".

      Default behavior:  Consult the ondemand table.  If any string value in
      the table matches the module name, return the key.  If any array
      value in the table contains an element that matches the module name,
      return {address: key, type: "script"}.  Otherwise, return the full
      module name unchanged.  (But the brower's resolve hook is different;
      see System.resolve below.)

      When the resolve hook is called:  For all imports, immediately after
      the normalize hook returns successfully, unless the normalize hook
      names a module that is already loaded or loading.

      P1 ISSUE #4:  Relative module names.

      P1 ISSUE #14:  Define how the ondemand table gets consulted.
    */
    resolve(normalized, options) {
        var address = this.@ondemandTableLookup(normalized, options.referer);
        return address === undefined ? normalized : address;
    }

    @ondemandTableLookup(normalized, referer) {
        /*
        */
        if (this.@locations === undefined) {
            /*
              P5 ISSUE: module names can appear in multiple values in the
              @ondemand table. This raises the question of ordering of
              duplicates.
            */
            var locations = $MapNew();
            for (let [url, contents] of $MapIterator(this.@ondemand)) {
                if (typeof contents === "string") {
                    $MapSet(locations, contents, url);
                } else {
                    // contents is an array.
                    for (let i = 0; i < contents.length; i++)
                        $MapSet(locations, contents[i], url);
                }
            }
            this.@locations = locations;
        }
        return $MapGet(this.@locations, normalized);
    }

    /*
      Asynchronously fetch the requested source from the given url
      (produced by the resolve hook).

      This is the one hook that must be overloaded in order to make the
      import keyword work. The default implementation simply schedules a
      call to the reject hook.

      The fetch hook should load the requested address and call the
      fulfill() callback, passing two arguments: the fetched source, as a
      string; and the actual address where it was found (after all
      redirects), also as a string.

      options.type is the string "module" when fetching a standalone
      module, and "script" when fetching a script. In the latter case the
      fetch hook should not call the done callback; it just reports an
      error. P3 ISSUE: Have the loader pass undefined instead?

      When the fetch hook is called:  For all modules and scripts whose
      source is not directly provided by the caller.  It is not called for
      the script bodies executed by loader.eval() and .evalAsync(), since
      those do not need to be fetched.  loader.evalAsync() can trigger this
      hook, for modules imported by the script.  loader.eval() is
      synchronous and thus never triggers the fetch hook.

      (loader.load() does not call normalize/resolve hooks but it does call
      the fetch/translate/link hooks, per samth, 2013 April 22.)

      The fetch hook may call the fulfill/reject/done callback
      synchronously rather than waiting for the next event loop turn.
      Per meeting, 2013 April 26.

      P2 ISSUE: #9: synchronous calls to fulfill()

      I think samth and I agree that a synchronous fulfill() callback
      should not synchronously call translate/link hooks, much less
      normalize/resolve/fetch hooks for dependencies. TODO: Code that up.

      TODO: comment default behavior
    */
    fetch(resolved, fulfill, reject, done, options) {
        AsyncCall(() => reject($TypeError("Loader.prototype.fetch was called")));
    }

    /*
      Optionally translate src from some other language into JS.

      When the translate hook is called:  For all modules and scripts.  The
      default implementation does nothing and returns src unchanged.
      (Note:  It is not decided whether this is called for direct eval
      scripts; see issue on Loader.eval().)
    */
    translate(src, options) {
        return src;
    }

    /*
      The link hook allows a loader to optionally override the default
      linking behavior.  There are three options.

       1. The link hook may return undefined. The loader then uses the
          default linking behavior.  It compiles src as an ES module, looks
          at its imports, loads all dependencies asynchronously, and
          finally links them as a unit and adds them to the registry.

          The module bodies will then be executed on demand; see
          @ensureExecuted.

       2. The hook may return a full Module instance object. The loader
          then simply adds that module to the registry.

          P3 ISSUE #17: Timing in this case.
          P3 ISSUE #18: link hook returning a Module vs. loader.set().

       3. The hook may return a factory object which the loader will use to
          create the module and link it with its clients and dependencies.

          The form of a factory object is:  {
              imports: <array of strings (module names)>,
              ?exports: <array of strings (property names)>,
              execute: <function (Module, Module, ...) -> Module>
          }

          The array of exports is optional.  If the hook does not specify
          exports, the module is dynamically linked.  In this case, it is
          executed during the linking process.  First all of its
          dependencies are executed and linked, and then passed to the
          relevant execute function.  Then the resulting module is linked
          with the downstream dependencies.  This requires incremental
          linking when such modules are present, but it ensures that
          modules implemented with standard source-level module
          declarations can still be statically validated.

          P3 ISSUE #19: how does this work?

      When the link hook is called:  Immediately after the translate hook,
      for modules only.

      The default implementation does nothing and returns undefined.
    */
    link(src, options) {
    }
}

/*
  Rationale for timing and grouping of dependencies: Consider
      loader.evalAsync('import "x" as x; import "y" as y;', f);

  We wait to execute "x" until "y" has also been fetched. Even if "x" turns
  out to be linkable and runnable, its dependencies are all satisfied, it
  links correctly, and it has no direct or indirect dependency on "y", we
  still wait.

  Dependencies could be initialized more eagerly, but in a less
  deterministic order. The design opts for a bit more determinism in common
  cases-- though it is easy to trigger non-determinism since multiple
  link sets can be in-flight at once.
*/


/*
  The goal of a LoadTask is to resolve, fetch, translate, link, and compile
  a single module (or a collection of modules that all live in the same
  script).

  LoadTask objects are the values in a Loader's .@loading map.

  It is in one of four states:

  1.  Loading:  Source is not available yet.

      .status === "loading"
      .linkSets is a Set of LinkSets

  The task leaves this state when the source is successfully compiled, or
  an error causes the load to fail.

  LoadTasks in this state are associated with one or more LinkSets in a
  many-to-many relation. This implementation stores both directions of the
  relation: loadTask.linkSets is the Set of all LinkSets that require
  loadTask and linkSet.loads is the Set of all loadTasks that linkSet
  requires.

  2.  Loaded:  Source is available and has been "translated"; syntax has
  been checked; dependencies have been identified.  But the module hasn't
  been linked or executed yet.  We are waiting for dependencies.

  This implementation treats the Module object as already existing at this
  point (except for factory-made modules).  But it has not been linked and
  thus must not be exposed to script yet.

  The "loaded" state says nothing about the status of the dependencies; they
  may all be linked and executed and yet there may not be any LinkSet that's
  ready to link and execute this module.  The LinkSet may be waiting for
  unrelated dependencies to load.

      .status === "loaded"
      .script is a script or null
      .factory is a callable object or null
      .dependencies is an Array of strings (full module names)

  Exactly one of [.script, .factory] is non-null.

  The task leaves this state when a LinkSet successfully links the module
  and moves it into the loader's module registry.

  3.  Done:  The module has been linked and added to the loader's module
  registry.  Its body may or may not have been executed yet (see
  @ensureExecuted).

  (TODO: this is speculation) LoadTasks that enter this state are removed
  from the loader.@loading table and from all LinkSets; they become
  garbage.

  4.  Failed:  The load failed. The task never leaves this state.

      .status === "failed"
      .exception is an exception value
*/
class LoadTask {
    /*
      If the constructor argument is an array, it is the array of module names
      that we're loading; the task begins in the "loading" state.

      If the argument is a script, the task begins in the "loaded" state. This
      happens in eval() and evalAsync(): the eval script does not need to go
      through the "loading" part of the pipeline, but it must be linked.
    */
    constructor(namesOrScript) {
        this.fullNames = fullNames;
        if ($IsArray(namesOrScript)) {
            this.fullNames = namesOrScript;
            this.status = "loading";
            this.script = null;
        } else {
            this.fullNames = $ScriptDeclaredModuleNames(script);
            this.status = "loaded";
            this.script = script;
        }
        this.linkSets = $SetNew();
        this.factory = null;
        this.dependencies = null;
    }

    /*
      The loader calls this after the last loader hook (the .link hook),
      and after the script or module's syntax has been checked.

      1. Process module declarations.
      2. Process imports. This may trigger additional loads.
      3. Call .onLoad on any listening LinkSets (see that method for the
      conclusion of the load/link/run process).

      On success, this transitions the LoadTask from "loading" status to
      "loaded".

      In this implementation, `script` is a compiled script object
      representing the result of compiling either a module or a script.
    */
    finish(loader, actualAddress, script) {
        $Assert(this.status === "loading");

        loader.@checkModuleDeclarations(script, this);

        let pairs = $ScriptImports(script);
        let fullNames = [];
        let sets = this.linkSets;

        /*
          When we load a script, we add all its modules and their
          dependencies to the same link set, per samth, 2013 April 22.

          TODO: implement that for the declared modules

          Example:
              module "A" {
                  import "B" as B;
                  B.hello();
              }
              alert("got here");

          Note that toplevel does not import "A", so the body of "A"
          will not execute, and we will not call B.hello().
          Nevertheless, we load "B.js" before executing the script.
        */
        for (let i = 0; i < pairs.length; i++) {
            let [client, request] = pairs[i];
            let referer = {name: client, url: actualAddress};
            let fullName;
            try {
                fullName = loader.@import(referer, request);
            } catch (exc) {
                return this.fail(exc);
            }
            fullNames[i] = fullName;

            if (!$MapHas(this.@modules, fullName)) {
                /*
                  Add the new LoadTask to each LinkSet even if it is done
                  loading, because the association keeps the LoadTask alive
                  (LoadTasks are reference-counted; see onLinkSetFail).

                  ISSUE: whether to keep a copy
                */
                let load = $MapGet(this.@loading, fullName);
                for (let j = 0; j < sets.length; j++)
                    sets[j].addLoad(load);
            }
        }

        this.status = "loaded";
        this.dependencies = fullNames;
        for (let i = 0; i < sets.length; i++)
            sets[i].onLoad(this);
    }

    /*
      Cancel this load because the fetch hook either merged it with another
      fetch or used loader.eval() or loader.set() to put a finished module
      into the registry.

      (Used by the done() callback in Loader.@import().)
    */
    onEndRun(name, mod) {
        throw TODO;
    }

    /*
      Error handling.

      Every error that can occur throughout the process (with one
      exception; see exhaustive list in the next comment, below XXX TODO
      update this comment) is related to either a specific in-flight
      LoadTask (in loader.@loading) or a specific LinkSet.

      When such an error occurs:

       1. Compute the set F of LinkSets we are going to fail, as
          follows:

            * If the error is related to a single LinkSet (that is, it
              is a link error or an execution error in a module or script),
              let F = a set containing just that LinkSet.

            * If the error is related to an in-flight LoadTask (that is, it
              has to do with a hook throwing, returning an invalid value,
              calling a fulfill callback inorrectly, or calling the reject
              callback), let F = the set of LinkSets that needed that
              module.

       2. Let M = the set of all in-flight modules (in loader.@loading)
          that are not needed by any LinkSet other than those in F.

          P3 ISSUE #20: Can the set M be computed efficiently?

       3. TODO revise this super-hand-wavy pseudo-formal spec:

          Silently try linking all these remaining modules in M.  If any
          have link errors, or have dependencies (transitively) that have
          link errors, or have dependencies that aren't compiled yet, or
          have dependencies that are neither in M nor in the registry,
          throw those away; but no exception is thrown, nor error reported
          anywhere, for link errors in this stage.  Commit those that do
          link successfully to the registry. (They'll execute on demand
          later.  This whole step is just using the registry as a cache.)

       4. Remove all other in-flight modules found in step 2 from
          loader.@loading.  If any are in "loading" state, neuter the fetch
          hook's fulfill/reject/skip callbacks so that they become no-ops.
          Cancel those fetches if possible.

          P4 ISSUE: cancellation and fetch hooks

       5. Call the errback hooks for each LinkSet in F.

          P5 ISSUE:  Ordering.  We can spec the order to be the order of
          the import()/load()/asyncEval() calls, wouldn't be hard.

      After that, we drop the failed LinkSets and they become garbage.

      Note that any modules that are already linked and committed to
      the module registry (loader.@modules) are unaffected by the error.
    */

    /*
      For reference, here are all the kinds of errors that can
      occur. This list is meant to be exhaustive.

      Errors related to a LoadTask:

      - For each module, we call all five loader hooks, any of which
        can throw or return an invalid value.

      - The normalize, resolve, and link hooks may return objects that are
        then destructured.  These objects could throw from a getter or
        Proxy trap during destructuring.

      - The fetch hook can report an error via the reject() callback
        (and perhaps skip() though it's not clear to me what that is).

      - We can fetch bad code and get a SyntaxError trying to compile
        it.

      Errors related to a LinkSet:

      - During linking, we can find that a factory-made module is
        involved in an import cycle. This is an error.

      - A "static" linking error: a script or module X tries to import
        a binding from a module Y that isn't among Y's exports.

      - A factory function can throw or return an invalid value.

      - After linking, we add all modules to the registry.  This fails if
        there's already an entry for any of the module names.

      - Execution of a module body or a script can throw.

      Other:

      - The normalize hook throws or returns an invalid value.  This
        happens so early in the load process that there is no LoadTask yet.
        We can directly call the errback hook.  TODO see if this really fits
        in here...

      - The fetch hook errors described above can happen when fetching
        script code for a load() call. Again, this happens very early in
        the process; no LinkSets and no modules are involved. We can skip
        the complex error-handling process and just directly call the
        errback hook.
    */

    /*
      Fail this load task. All LinkSets that require it also fail.
    */
    fail(exc) {
        $Assert(this.status === "loading");
        this.status = "failed";
        this.exception = exc;
        let sets = $SetElements(this.linkSets);
        for (let i = 0; i < sets.length; i++)
            sets[i].fail(exc);
        $Assert($SetSize(sets) === 0);
    }

    /*
      This is called when a LinkSet associated with this load fails.
      If this load is not needed by any surviving LinkSet, drop it.
    */
    onLinkSetFail(loader, linkSet) {
        $Assert($SetHas(this.linkSets, linkSet));
        $SetDelete(this.linkSets, linkSet);
        if ($SetSize(this.linkSets) === 0) {
            for (let i = 0; i < this.fullNames.length; i++) {
                let fullName = this.fullNames[i];
                let currentLoad = $MapGet(loader.@loading, fullName);
                if (currentLoad === this)
                    $MapDelete(loader.@loading, fullName);
            }
        }
    }
}

/*
  A LinkSet represents a call to loader.evalAsync(), .load(), or .import().
*/
class LinkSet {
    constructor(loader, startingLoad, callback, errback) {
        // TODO: make LinkSets not inherit from Object.prototype, for isolation;
        // or else use symbols for all these; or else use define(). :-P
        this.loader = loader;
        this.startingLoad = startingLoad;
        this.callback = callback;
        this.errback = errback;

        this.loads = $SetNew();

        // Invariant: this.loadingCount is the number of LoadTasks in
        // this.loads whose .status is "loading".
        this.loadingCount = 0;

        this.addLoad(startingLoad);
    }

    addLoad(loadTask) {
        if (loadTask.status === "failed")
            return this.fail(loadTask.exception);

        if (!$SetHas(this.loads, loadTask)) {
            if (loadTask.status === "loading")
                this.loadingCount++;
            $SetAdd(this.loads, loadTask);
            $SetAdd(loadTask.linkSets, this);
        }
    }

    /*
      LoadTask.prototype.finish calls this after one LoadTask actually
      finishes, and after kicking off loads for all its dependencies.
     */
    onLoad(loadTask) {
        $Assert($SetHas(this.loads, loadTask));
        $Assert(loadTask.status === "loaded");
        if (--this.loadingCount === 0) {
            // Link, then schedule the callback (which actually runs the
            // code).
            try {
                this.link();
            } catch (exc) {
                this.fail(exc);
                return;
            }

            AsyncCall(this.callback);
        }
    }

    link() {
        // TODO - need a starting {script, dependencyFullNames} pair.
        let {script, dependencies} = throw TODO;

        let linkedNames = [];
        let linkedModules = [];
        let seen = $SetNew();

        // Depth-first walk of the import tree, stopping at already-linked
        // modules.
        function walk(task, script, deps) {
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
                if (task === undefined) {
                    if ($MapHas(this.loader.@loading, fullName)) {
                        throw $SyntaxError(
                            "script declares module \"" + fullName + "\", " +
                            "which is already loading");
                    }
                } else {
                    let current = $MapGet(this.loader.@loading, fullName);

                    // These two cases can happen if a script unexpectedly
                    // declares modules not named by resolve().other.
                    if (current === undefined) {
                        // Make sure no other script in the same LinkSet
                        // declares it too.
                        $MapSet(this.loader.@loading, fullName, this);
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
            let mods = [];
            for (let i = 0; i < deps.length; i++) {
                let fullName = deps[i];
                let mod = $MapGet(this.loader.@modules, fullName);
                if (mod !== undefined) {
                    let load = $MapGet(this.loader.@loading, fullName);
                    if (load === undefined || load.status !== "loaded") {
                        throw $SyntaxError(
                            "module \"" + fullName + "\" was deleted from the loader");
                    }
                    mod = $ScriptGetDeclaredModule(load.script, fullName);
                    if (mod === undefined) {
                        throw $SyntaxError(
                            "module \"" + fullName + "\" was deleted from the loader");
                    }
                    if (!$SetHas(seen, load.script))
                        walk(load, load.script, load.dependencies);
                }
                $ArrayPush(mods, mod);
            }

            // Finally, link the script.  This throws if the script tries
            // to import bindings from a module that the module does not
            // export.
            $LinkScript(script, mods);
        }

        // Link all the scripts and modules together.  This can throw
        // partway through.  P4 ISSUE: What happens to the already-linked
        // modules then? They may or may not be linked to other modules
        // that can't be recovered.
        walk(undefined, script, dependencies);

        // Move the fully linked modules from the @loading table to the
        // @modules table.
        for (let i = 0; i < linkedNames.length; i++) {
            $MapDelete(this.loader.@loading, linkedNames[i]);
            $MapSet(this.loader.@modules, linkedNames[i], linkedModules[i]);
        }
    }

    addScriptAndDependencies(script) {
        // TODO - this will look something like LoadTask.finish().
    }

    /*
      Fail this LinkSet.  Detach it from all loads and schedule the error
      callback.
    */
    fail(exc) {
        let loads = $SetElements(this.loads);
        for (let i = 0; i < loads.length; i++)
            loads[i].onLinkSetFail(this.loader, this);
        AsyncCall(this.errback, exc);
    }
}

/* ES6 ToBoolean abstract operation. */
function ToBoolean(v) {
    return !!v;
}

/*
  Return true if Type(v) is Object.
*/
function IsObject(v) {
    // TODO: I don't think this is correct per ES6. May not be a good way
    // to do it.
    return (typeof v === "object" && v !== null) ||
           typeof v === "function";
}

/*
  Schedule fn to be called with the given arguments during the next turn of
  the event loop.

  (This is used to schedule calls to success and failure callbacks, since
  the spec requires that those always be called from an empty stack.)
*/
function AsyncCall(fn, ...args) {
    $QueueTask(() => fn(...args));
}

export var System = new Loader;

export function ondemandTableLookup(loader, normalized, referer) {
    return loader.@ondemandTableLookup(normalized, referer);
}
