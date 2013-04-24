/*
  loaders.js - pseudo-implementation of proposed ES6 module loaders

  This is currently extremely incomplete.  The following are in decent shape:
    - the Loader constructor;
    - .eval(src, options) and @ensureModuleExecuted;
    - .load(url, done, fail);
    - .get(name), .has(name), .set(name, module), .delete(name);
    - .ondemand(sources).
  The following are partly implemented:
    - .evalAsync(src, done, fail, options)
    - .import(name, done, fail, options)
  Everything else is a mess.

  If you imagine loading as happening in three phases:
    - from load()/import()/eval()/asyncEval() up to the fetch hook
    - from the fulfill callback up to linkage
    - executing module bodies and scripts
  then the code here focuses on the first phase, with the easy bits of the
  third phase implemented too.


  The module loader is implemented in three classes, only one of which is
  ever visible to scripts.

  Loader - The public class.  Its API is standard-track, but no detailed
    specification text has been written yet.  This implementation uses the
    following documents as a starting point:

    https://docs.google.com/document/d/1FL3VF_OEwMPQ1mZKjxgR-R-hkieyyZO-8Q_eNTiyNFs/edit#

    https://gist.github.com/wycats/51c96e3adcdb3a68cbc3

    In addition many details of the behavior have been pinned down in IRC
    conversations with Sam Tobin-Hochstadt and David Herman.

  LinkageUnit - Stores state for a particular call to loader.load(),
    .evalAsync(), or .import().

  ModuleStatus - Stores the status of a particular module from the time we
    first decide to load it until it is fully linked and ready to execute.
*/

/*
  TODO: Look up how "intrinsics" work and wire that through everything.
*/

/*
  evalAsync, import, load, and the fetch hook all use callbacks.  They are
  designed to be upwards-compatible to Futures.  per samth, 2013 April 22.
*/

"use strict";

import {
    // Embedding features
    $ReportUncaughtException,
    $AddForNextTurn,
    $ToAbsoluteURL,
    $DefaultFetch,
    $Assert,

    // Capabilities that JS provides, but via methods that other code could
    // delete or replace
    $ToString,      // $ToString(v) === ES ToString algorithm ~= ("" + v)
    $Apply,         // $Apply(f, thisv, args) ~= thisv.apply(f, args)
    $Call,          // $Call(f, thisv, ...args) ~= thisv.call(f, ...args)
    $ObjectDefineProperty, // $ObjectDefineProperty(obj, p, desc) ~= Object.defineProperty(obj, p, desc)
    $ArrayPush,     // $ArrayPush(arr, v) ~= Object.defineProperty(arr, arr.length, {configurable: true, enumerable: true, writable: true, value: v})
    $ArrayPop,      // $ArrayPop(arr) ~= arr.pop()
    $SetNew,        // $SetNew() ~= new Set
    $SetHas,        // $SetHas(set, v) ~= set.has(v)
    $SetAdd,        // $SetAdd(set, v) ~= set.add(v)
    $MapNew,        // $MapNew() ~= new Map
    $MapHas,        // $MapHas(map, key) ~= map.has(key)
    $MapGet,        // $MapGet(map, key) ~= map.get(key)
    $MapSet,        // $MapSet(map, key, value) ~= map.set(key, value)
    $MapDelete,     // $MapDelete(map, key) ~= map.delete(key)
    $MapIterator,   // $MapIterator(map) ~= map[@@iterator]()
    $PropertyIterator, // $PropertyIterator(obj) ~= default for-of iteration behavior???
    $TypeError,     // $TypeError(msg) ~= new TypeError(msg)

    // Modules
    $LinkModule,
    $ModuleGetLinkedModules,
    $ModuleHasExecuted,
    $ModuleSetExecuted,
    $ExecuteModuleBody,

    // Scripts
    $CompileScript,
    $LinkScript,
    $ExecuteScript,
    $ScriptImportedModuleNames,

    // Globals
    $DefineBuiltins
} from "implementation-intrinsics";

module "js/loaders" {
    /*
      Return true if Type(v) is Object.
    */
    function IsObject(v) {
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
        $AddForNextTurn(() => fn(...args));
    }

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
      linked modules.  The Loader tries to avoid downloading modules multiple
      times, even when multiple load() calls need the same module before it is
      ready to be added to the registry.

      Loader hooks. The import process can be customized by assigning to (or
      subclassing and overriding) any number of the five loader hooks:
          normalize(name) - From a relative module name, determine the full
              module name.
          resolve(fullName, options) - Given a full module name, determine the
              URL to load and whether we're loading a module or a script.
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
        */
        constructor(parent, options) {
            /*
              this.@modules is the module registry.  It maps full module names
              to Module objects.

              This map only ever contains Module objects that have been fully
              linked.  However it can contain modules whose bodies have not yet
              started to execute.  Except in the case of cyclic imports, such
              modules are not exposed to user code without first calling
              Loader.@ensureModuleExecuted().
            */
            this.@modules = $MapNew();

            /*???
              this.@loading stores the status of modules that are loading and
              not yet linked.  It maps module names to ModuleStatus objects.

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
            this.@global = options.global;
            this.@strict = !!options.strict;
            this.@baseURL = $ToString(options.baseURL);

            /*
              ISSUE: DETAILED BEHAVIOR OF HOOKS

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
            var self = this;
            function takeHook(name) {
                var hook = options[name];
                if (hook !== undefined) {
                    $ObjectDefineProperty(self, name, {
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
        }

        /*
          Try to ensure that the module mod and all its dependencies,
          transitively, have started to execute exactly once (that is, the
          $ModuleHasExecuted bit is set on all of them) by executing the
          dependencies that have never started to execute.

          mod and its dependencies must already have been linked.

          Dependencies are executed in depth-first, left-to-right, post order,
          stopping at cycles.
        */
        static @ensureModuleExecuted(mod) {
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

              Other fully linked modules in the same LinkageUnit are also left
              in the registry (per dherman, 2013 April 18).  Some of those may
              be unrelated to the module that threw.  Since their "has ever
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

            function walk(m) {
                $SetAdd(seen, m);

                let deps = $ModuleGetLinkedModules(mod);
                for (let i = 0; i < deps.length; i++) {
                    let dep = deps[i];
                    if (!$SetHas(seen, dep))
                        walk(dep);
                }

                if (!$ModuleHasExecuted(m))
                    $ExecuteModuleBody(m);
            }

            walk(mod);
        }

        /*
          Execute the program src.

          src may import modules, but if it imports a module that is not
          already in this loader's module registry, an error is thrown.

          options.url is used as the script's filename.  (This may be used in
          Error objects thrown while executing the program, and it may appear
          in debugging tools.)

          Loader hooks:  This calls only the translate hook.  per samth,
          2013 April 22.  See rationale in the comment for evalAsync().

          SECURITY ISSUE: This will allow Web content to run JS code that
          appears (in the devtools, for example) to be from any arbitrary URL.
          We might be able to constrain this to only same-domain URLs or
          something.  But ideally that filename just doesn't matter.  It
          certainly shouldn't matter to any code; code really shouldn't be
          looking at Error().stack or Error().fileName for security purposes!

          ISSUE:  What about letting the user set the line number?
          samth is receptive.  2013 April 22.

          NOTE:  The google doc mentions another option, options.module, which
          would be a string and would cause all imports to be normalized
          relative to that module name.  per samth, 2013 April 22.  jorendorff
          objected to this feature and it is not presently implemented.

          ISSUE:
          <jorendorff> samth: so does global.eval also go through the translate hook?
          <jorendorff> ...even direct eval?
          <samth> jorendorff: yes
          <samth> well, i think so
          <samth> i seem to recall dherman disagreeing
          (2013 April 22)
        */
        eval(src, options) {
            let url = this.@baseURL;
            if (options !== undefined && "url" in options) {
                url = options.url;
                if (typeof url !== 'string')
                    throw $TypeError("eval: options.url must be a string");
            }

            let script = $CompileScript(this, src, url);

            /*
              Linking logically precedes execution, so the code below has two
              separate loops.  Fusing the loops would be observably different,
              because the body of module "A" could do System.delete("B").

              First loop: Look up all modules imported by src.
            */
            let names = $ScriptImportedModuleNames(script);
            let modules = [];
            let referer = {name: null, url: url};
            for (let i = 0; i < names.length; i++) {
                let name = this.normalize(names[i], {referer});

                let m = $MapGet(this.@modules, name);
                if (m === undefined) {
                    /*
                      Rationale for throwing a SyntaxError: SyntaxError is
                      already used for a few conditions that can be detected
                      statically (before a script begins to execute) but are
                      not really syntax errors per se.  Reusing it seems
                      better than inventing a new Error subclass.
                    */
                    throw new SyntaxError("module not loaded: " + name);
                }
                $ArrayPush(modules, m);
            }

            /*
              The modules are already linked.  Now link the script.  Since
              this can throw a link error, it is observable that this happens
              before dependencies are executed below.
            */
            $LinkScript(script, modules);

            /*
              Second loop:  Execute any module bodies that have not been
              executed yet.  Module bodies may throw.

              Loader.@ensureModuleExecuted() can execute other module bodies in
              the graph, to ensure that barring cycles, a module is always
              executed before other modules that depend on it.
            */
            for (let i = 0; i < modules.length; i++)
                Loader.@ensureModuleExecuted(modules[i]);

            return $ExecuteScript(script);
        }

        /*
          Create a callback which calls work(), then either passes its return
          value to the done callback (on success) or passes the exception to
          the fail callback (on exception).
        */
        static @makeContinuation(work, done, fail) {
            return () => {
                /*
                  Tail calls would probably be equivalent to AsyncCall,
                  depending on the exact semantics of $AddForNextTurn.
                  This is meant as a reference implementation, so we just
                  literal-mindedly do what the spec is expected to say.
                */
                let result;
                try {
                    result = work();
                } catch (exc) {
                    AsyncCall(fail, exc);
                    return;
                }
                AsyncCall(done, result);
            };
        }

        /*
          Asynchronously evaluate the program src.  If it evaluates
          successfully, pass the result value to the done callback.  If parsing
          src throws a SyntaxError, or evaluating it throws an exception, pass
          the exception to the fail callback.

          src may import modules that have not been loaded yet.  In that case,
          load all those modules, and their imports, transitively, before
          evaluating the script.  If an error occurs during loading, pass it to
          the fail callback.

          Loader hooks: For src, only the translate hook is called.  per samth,
          2013 April 22.  (Rationale: The normalize and resolve
          hooks operate on module names; src doesn't have a module name. The
          fetch hook is for loading code; we've already got the code we want to
          execute.  And the link hook also only applies to modules.  The
          translate hook, however, still applies.)  TODO: implement this.

          Of course for modules imported by src, all the loader hooks may be
          called.

          The done() or fail() callback is always called in a fresh event loop
          turn.

          options.url, if present, is used to determine the location of modules
          imported by src (unless the resolve hook overrides the default
          behavior).  That is, if options.url is present, its "parent
          directory" overrides this.baseURL for the purposes of importing stuff
          for this one program.

          (options.module is being specified, to serve an analogous purpose for
          normalization, but it is not implemented here. See the comment on
          eval().)
        */
        evalAsync(src, done, fail, options) {
            return this.@evalAsync(src, done, fail, options);
        }

        @evalAsync(src, done, fail, options) {
            /*
              TODO: $ParentUrl(options.url) should be used in place of baseURL
              for the purposes of default resolve behavior in here.
            */

            let script;
            try {
                script = $CompileScript(this, code, options.url);
            } catch (exc) {
                AsyncCall(fail, exc);
                return;
            }

            let ctn = Loader.@makeContinuation(() => $ScriptExec(script), done, fail);
            let unit = new LinkageUnit(this, ctn, fail);
            unit.addScriptAndDependencies(script);

            /*
              ISSUE: EXECUTION ORDER WHEN MULTIPLE LINKAGE UNITS BECOME
              LINKABLE AT ONCE.

              Proposed: When a fetch fulfill callback fires and completes the
              dependency graph of multiple linkage units at once, they are
              linked and executed in the order of the original
              load()/evalAsync() calls.

              samth is unsure but thinks probably so.
            */
        }

        /*
          ISSUE:  Proposed name for this method: addSources(sources)
        */
        ondemand(sources) {
            /*
              ISSUE: Propose using the default iteration protocol for the outer
              loop too.
            */
            for (let [url, contents] of $PropertyIterator(sources)) {
                if (contents === null) {
                    $MapDelete(this.@ondemand, url);
                } else if (typeof contents === 'string') {
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
                    */
                    let names = [];
                    for (let name of contents) {
                        if (typeof name !== 'string')
                            throw $TypeError("ondemand: module names must be strings");
                        $ArrayPush(names, name);
                    }
                    $MapSet(this.@ondemand, url, names);
                }
            }

            // Destroy the reverse cache.
            this.@locations = undefined;
        }

        /*
          Asynchronously load and run a script.  If the script contains import
          declarations, this can cause modules to be loaded, linked, and
          executed.

          On success, call the done callback.

          ISSUE: Does this capture the result of evaluating the script and pass
          that value to the callback?  The code below assumes yes.

          On error, pass an exception value or error message to the fail
          callback.

          The callbacks will not be called until after evalAsync returns.

          ISSUE:  What should happen if the fetch hook calls skip() when we're
          trying to fetch a script, not a module?

          RESOLVED:  An error (reported to the fail callback).

          ISSUE:  The google doc says:
              Loader.prototype.load(url, callback, errback, { url }) -> void
          I count two "url" arguments there.

          TODO: load modules relative to url

          ISSUE: I think the spec has the default errback doing nothing; the
          reason I have it throwing is so that if something fails, and no error
          callback was provided, the browser embedding will see it as an
          uncaught excpetion and log it to the console.
        */
        load(url,
             done = () => undefined,
             fail = exc => { throw exc; })
        {
            /*
              This method only does two things.

              1. Call the fetch hook to load the script from the given url.

              2. Once we get the source code, pass it to asyncEval() which does
                 the rest.  (Implementation issue: This reuse causes a single
                 extra turn of the event loop which we could eliminate; not
                 sure how visible it would be from a spec perspective.)
            */

            /*
              ISSUE: Check callability of callbacks here (and everywhere
              success/failure callbacks are provided)?  It would be a mercy,
              since the TypeError if they are not functions happens much later
              and with an empty stack.  But Futures don't do it.  Assuming no.

              if (typeof done !== 'function')
                  throw $TypeError("Loader.load: callback must be a function");
              if (typeof fail !== 'function')
                  throw $TypeError("Loader.load: error callback must be a function");
            */

            /*
              Rationale for creating an empty object for metadata: The
              normalize hook only makes sense for modules; load() loads
              scripts.  But we do want load() to use the fetch hook, which
              means we must come up with a metadata value of some kind
              (this is ordinarily the normalize hook's responsibility).

              ISSUE:  Is loader.load() supposed to call the fetch hook?

              RESOLVED:  Yes.  loader.load() does not call normalize/resolve
              hooks but it does call the fetch/translate/link hooks.  per
              samth, 2013 April 22.
            */
            let metadata = {};

            let fetchOptions = {
                normalized: null,
                referer: null,
                metadata: metadata
            };

            /*
              ISSUE: USER HOOKS AND CALLBACK MISUSE.  The fetch hook is user
              code.  Callbacks the Loader passes to it are subject to every
              variety of misuse.  They must cope with being called multiple
              times (which should be a no-op, for Future compatibility) and
              with invalid arguments.  The being called multiple times thing is
              what this fetchCompleted flag is about.

              Rationale for fetchCompleted:  Compatibility with Futures.
              Consquentially, a fetch hook can try two ways of fetching a file
              asynchronously, in parallel, and just let them race; the first
              result wins and the rest are ignored.
            */
            let fetchCompleted = false;

            /*
              ISSUE: USER HOOKS AND TOO-FAST CALLBACKS.  All the Loader methods
              promise not to call any callbacks before returning; even if the
              method has all the information it needs to report an error, it
              schedules the fail() callback to be called during the next event
              loop turn.  Should we hold user hooks to the same standard?  What
              should happen if they call a callback immediately?
            */
            function fulfill(src, type, actualAddress) {
                if (fetchCompleted)
                    return;
                fetchCompleted = true;

                if (typeof src !== 'string') {
                    let msg = "load() fulfill callback: first argument must be a string";
                    AsyncCall(fail, $TypeError(msg));
                }
                if (type !== 'script') {
                    let msg = "load() fulfill callback: second argument must be 'script'";
                    AsyncCall(fail, $TypeError(msg));
                }
                if (typeof actualAddress !== 'string') {
                    let msg = "load() fulfill callback: third argument must be a string";
                    AsyncCall(fail, $TypeError(msg));
                }

                this.@evalAsync(src, done, fail, {url: actualAddress, metadata: metadata});
            }

            function reject(exc) {
                if (fetchCompleted)
                    return;
                fetchCompleted = true;

                AsyncCall(fail, exc);
            }

            function mischiefManaged() {
                if (fetchCompleted)
                    return;
                fetchCompleted = true;

                /* ISSUE: what kind of error to throw here. */
                let msg = "load(): fetch hook must not call mischiefManaged() callback";
                AsyncCall(fail, $TypeError(msg));
            }

            /*
              ISSUE: Type of the argument to reject(). The Google doc says
                  reject: (message: string) -> void
              but I think we should allow the argument to be any value.
              (Futures are like that.)
            */

            /*
              ISSUE:  If the fetch hook throws, does load() catch that and
              forward to the error callback?  Assuming yes.
            */
            try {
                this.fetch(null, fulfill, reject, skip, fetchOptions);
            } catch (exc) {
                /*
                  Call reject rather than calling the fail() callback directly.
                  Otherwise a badly-behaved fetch hook could reject() and then
                  throw, causing fail() to be called twice.
                */
                reject(exc);
            }
        }

        /*
          Asynchronously load, link, and execute a module and any dependencies
          it imports.  On success, pass the Module object to the done callback.
          On error, pass an exception value or error message to the fail
          callback.

          The callbacks will not be called until after evalAsync returns.

          ISSUE: The google doc says
              Loader.prototype.import(moduleName, callback, staticerrback,
                                      dynamicerrback, { module, url }) -> void
          but I can't tell what { url } is supposed to be.
          In particular the url is computed via the resolve hook, right?
          Does the url option override that?

          ISSUE: After conversations with samth and dherman, I think we're
          mostly in agreement that we don't need separate staticerrback and
          dynamicerrback arguments.  -jorendorff 2013 April 20.
        */
        import(moduleName,
               done = () => undefined,
               fail = (exc) => { throw exc; },
               options = undefined)
        {
            // Build referer.
            let name = null, url = this.@baseURL;
            if (options !== undefined) {
                if ("module" in options) {
                    name = options.module;
                    if (typeof name !== 'string')
                        throw $TypeError("import: options.module must be a string");
                }
                if ("url" in options) {
                    url = options.url;
                    if (typeof url !== 'string')
                        throw $TypeError("import: options.url must be a string");
                }
            }

            function success(m) {
                Loader.@ensureModuleExecuted(m);
                return done(m);
            }

            this.@importFor({name, url}, moduleName, null, success, fail);
        }

        /*
          The common implementation of the import() method and the processing
          of import declarations in ES code.  There are two ways to call this
          method:

          - If unit is non-null, it the result is reported to the unit via one
            of these callback methods:
              unit.onLinkedModule(name, module)
              unit.addModuleAndDependencies(normalized, status)
              unit.fail(exc)
            In this case done and fail must be null.

          - If unit is null, then done and fail must be functions. In this
            case, the loader fully loads the requested module. It creates a new
            LinkageUnit to oversee the process, if there isn't already a
            LinkageUnit that's exactly what we need. The result is either an
            error, reported via fail(exc), or a Module object that has the
            $ModuleHasExecuted bit set, reported via done(module).

          In both cases, no callback is called before @importFor returns. If
          the module is already in the registry, success is reported in the
          next turn of the event loop.

          Implementation issue:  matching fetch callbacks to @importFor
          invocations.

          Not clear how the LinkageUnit will figure out what on earth it's
          looking at when its callback eventually gets called.  Modules don't
          even have a name property, plus when this gets called we do not yet
          know what the normalized name will be.  It can be done with another
          few closures, to be sure...

          TODO:  suggest alternative name for options.referer. It really means
          "fullNameOfImportingModule", nothing to do with the nasty
          Referer HTTP header.  Perhaps "importContext".

          TODO:  Implementation issue:  referer should be provided by the caller.
        */
        @importFor(referer, name, unit, done, fail) {
            if (unit !== null) {
                done = mod => unit.onLinkedModule(name, mod); ???
                fail = exc => unit.fail(exc);
            }

            /*
              Call the normalize hook to get a normalized module name and
              metadata.  See the comment on normalize().
            */
            let normalized, metadata;
            try {
                let result = this.normalize(request, {referer});

                /*
                  Interpret the value returned by the normalize hook.

                  It must be undefined, a string, or an object with a
                  .normalized property whose value is a string.  Otherwise a
                  TypeError is thrown.  per samth, 2013 April 22.
                */
                metadata = undefined;
                if (result === undefined) {
                    normalized = request;
                } else if (typeof result === "string") {
                    normalized = result;
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
                if (metadata === undefined)
                    metadata = {};
            } catch (exc) {
                AsyncCall(fail, exc);
                return;
            }

            // If the module has already been loaded and linked, return that.
            let m = $MapGet(this.@modules, moduleName);
            if (m !== undefined) {
                if (unit !== null) {
                    $AddForNextTurn(() => unit.onModule(m));
                } else {
                    // In this case, if the module has never been executed, we
                    // must do so before calling done().
                    let work = () => {
                        Loader.@ensureModuleExecuted(m);
                        return m;
                    };
                    $AddForNextTurn(Loader.@makeContinuation(work, done, fail));
                }
                return;
            }

            /*
              ISSUE: duplicate import() calls with mismatched options.

              What should happen when:
              System.import("x", done, fail, {url: "x1.js"});
              System.import("x", done, fail, {url: "x2.js"});  // different url

              If we see the registry purely as a cache, we should really get
              two competing loads here, and whichever one finishes later gets
              an error... hmm. Perhaps a synchronous error on the second
              System.import() call would be better.
            */

            // If the module is loading, attach to the existing in-flight load.
            let status = $MapGet(this.@loading, normalized);
            if (status !== undefined) {
                // This module is already loading.

                /*
                  ISSUE: We have called the normalize hook, which may have
                  created metadata.  If so, that metadata is just dropped.
                  No user hook is ever notified about it.  This is
                  probably OK but I want to check.
                */

                if (unit !== null) {
                    // Add the existing ModuleStatus to the existing
                    // LinkageUnit.
                    unit.addModuleAndDependencies(normalized, status);
                } else if (status.soloLinkageUnit !== null) {
                    // There is already a LinkageUnit consisting of only this
                    // module and its dependencies. Piggyback on that.
                    status.soloLinkageUnit.addListeners(done, fail);
                } else {
                    // Some other LinkageUnit is loading this module as
                    // part of another module or script's dependency graph.
                    // Make a new LinkageUnit loading just this module.
                    this.@addLinkageUnitForModule(normalized, status, done, fail);
                }
                return;
            }

            status = new ModuleStatus;
            status.addHooks(unit, done, fail); // ???
            $MapSet(this.@loading, normalized, status);

            try {
                // Call the resolve hook.
                let result = this.resolve(normalized, {referer, metadata});

                // Interpret the result.
                let address, type;
                if (typeof result === "string") {
                    address = result;
                    type = 'module';
                } else if (IsObject(result)) {
                    // result.address must be present and must be a string.
                    if (!("address" in result)) {
                        throw $TypeError("Object returned from loader.resolve hook " +
                                         "must have an .address property");
                    }
                    address = result.address;
                    if (typeof address !== "string") {
                        throw $TypeError(".address property of object returned from " +
                                         "loader.resolve hook must be a string");
                    }

                    // result.type is optional, but if present must be 'module' or 'script'.
                    if ("type" in result) {
                        type = result.type;
                        if (type !== "module" && type !== "script")
                            throw $TypeError(".type property of object returned from " +
                                             "loader.resolve hook must be either 'module' " +
                                             "or 'script'");
                    } else {
                        type = "module";
                    }
                }
            } catch (exc) {
                /*
                  Implementation issue:  This isn't implemented yet, but
                  status.fail() will be responsible for forwarding this error
                  to the unit or fail() hook, as well as all *other*
                  LinkageUnits and/or fail hooks that have attached to status
                  in the meantime.  It is also responsible for removing itself
                  from this.@loading.
                */
                status.fail(exc);
                return;
            }

            // Call the fetch hook.
            //
            // On error, we will catch the exception below and call fail().
            //
            // On success, success and failure notification is forwarded to
            // the ModuleStatus via these two lambdas. Note that these
            // lambdas do not call done() and fail().
            let fetchCompleted = false;

            function fulfill(src, type, actualAddress) {
                if (fetchCompleted)
                    return;
                fetchCompleted = true;

                // Implementation issue: check types here, before forwarding?
                return status.onFetch(src, type, actualAddress);
            }

            function reject(exc) {
                if (fetchCompleted)
                    return;
                fetchCompleted = true;

                return status.fail(exc);
            }

            /*
              ISSUE: what is skip()?

              The spec calls the third callback argument to the fetch hook
              'skip'.

              skip() means "i'm not going to fetch this url, you'll never hear
              from me again-- but don't worry about it, someone will get the
              modules you want and eval() or loader.set() them into existence".
              It is a way to support bulk-loading.  A fetch hook could respond
              to everything with skip()!

              But I think I talked samth into changing the hook to have a name
              like done() or, jokingly, mischiefManaged(), and require the
              fetch hook to call it only *after* the desired module is
              available.  The problem with skip() was that it left the loader
              with an impression that some work would be done, but no
              expectation of an error callback if it went wrong.  The error
              callback is important; failure must kill the whole LinkageUnit
              and call its fail hook.  --jorendorff, 2013 April 22.

              ISSUE: Want use cases/rationale for skip/mischiefManaged.
              --jorendorff, 2013 April 24.
            */
            function mischiefManaged() {
                if (fetchCompleted)
                    return;
                fetchCompleted = true;

                if ($MapHas(this.@modules, normalized))
                    status.cancel();
                else
                    status.fail($TypeError("mischief was not actually managed"));
            }

            try {
                this.fetch(address, fulfill, reject, mischiefManaged, {normalized, referer, metadata});
            } catch (exc) {
                status.fail(exc);
                return;
            }

            if (unit === null) {
                // Create a new LinkageUnit, subscribing the done() and fail()
                // callbacks to it so that fulfill() eventually triggers
                // done() and reject() immediately triggers fail().
                this.@addLinkageUnitForModule(normalized, status, done, fail);
            } else {
                // Add status to the existing LinkageUnit.
                unit.addModule(normalized, status);
                status.listeners.push(unit);
            }
        }

        @failLinkageUnits(units, exc) {
            /*
              TODO: Find stranded ModuleStatuses, remove them from
              this.@loading, and neuter their pending fetch() callbacks, if any
              (so that the translate hook is never called).

              If this failure is due to a ModuleStatus failing (e.g. a fetch
              failing), then this step will definitely remove the ModuleStatus
              that failed.

              ISSUE: There's no efficient way to find stranded
              ModuleStatuses. We can mark and sweep, if we keep a list of all
              the other not-yet-failing LinkageUnits.  Beginning to think
              "locking in" was the right idea after all.
            */

            // Call LinkageUnit fail hooks. (ISSUE: In what order?)
            for (let i = 0; i < units.length; i++) {
                let callbacks = units[i].failCallbacks;
                for (let j = 0; j < callbacks.length; j++) {
                    let fail = callbacks[j];
                    AsyncCall(fail, exc);
                }
            }
        }

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
            if (typeof name !== 'string')
                throw $TypeError("module name must be a string");

            let m = $MapGet(this.@modules, name);
            if (m !== undefined)
                Loader.@ensureModuleExecuted(m);
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
            if (typeof name !== 'string')
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
            if (typeof name !== 'string')
                throw $TypeError("module name must be a string");

            // TODO: implement test for valid module full name.

            if (!$IsModule(mod)) {
                /*
                  Rationale:  Entries in the module registry must actually be
                  Modules.  We do Module-specific operations like
                  $ModuleGetLinkedModules, $ModuleHasExecuted, and
                  $ExecuteModuleBody on them.  The spec will do the same.
                  per samth, 2013 April 22.
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

          Rationale: loader.delete("A") removes only "A" from the registry,
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

          loader.delete("A") has no effect at all if !loader.@modules.has("A"),
          even if "A" is currently loading (an entry exists in
          loader.@loading).  This is analogous to .set().  per (reading between
          the lines) discussions with dherman, 2013 April 17, and samth, 2013
          April 22.

          ISSUE:  EFFECTS OF MODULE REGISTRY DELETION ON IN-FLIGHT LINKAGE
          UNITS.  How does a delete() affect an in-flight evalAsync() that was
          going to use that module?

          Suppose a program loader.delete()s every module that loads, so that
          an in-flight load() never has all the modules it needs at one time.
          Does it keep trying to load the modules repeatedly?  Or does it
          eventually fail?

          RESOLVED: During load phase, whenever we find that some new code
          imports a module, we first check the registry, and failing that the
          table of in-flight loads.  If it is not in either table, we start a
          fresh load.  There is no per-linkage-unit state to prevent us from
          kicking off many loads of the same module during a single load phase;
          in the case of cyclic imports, if someone keeps deleting the
          successfully-loaded modules from the registry, we could go on
          indefinitely.

          After a succesful load phase, when all fetches, translate hooks, link
          hooks, and compiles have finished successfully, we move on to link
          phase.  We walk the graph again, starting from the root, and try to
          link all the not-yet-linked modules, looking up every imported module
          in the registry as we go.  If at this point we find that a module we
          need is no longer in the registry, that's a link error.

          per samth, 2013 April 22.
        */
        delete(name) {
            $MapDelete(this.@modules, name);
            return this;
        }

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
          Define all the built-in objects and functions of the ES6 standard
          library associated with this loader’s intrinsics as properties on
          obj.
        */
        defineBuiltins(obj = this.@global) {
            $DefineBuiltins(obj, this);
            return obj;
        }

        /* Loader hooks. */

        /*
          For each import() call or import-declaration, the Loader first calls
          loader.normalize(name, options) passing the module name as passed to
          import() or as written in the import-declaration.  This hook then
          returns a full module name which is used for the rest of the import
          process. (In particular, modules are stored in the registry under
          their full module name.)

          This hook is not called for the main script body executed by a call
          to loader.load(), .eval(), or .evalAsync().  But it is called for all
          imports, including imports in scripts.

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

            - undefined, equivalent to returning name unchanged; OR

            - an object that has a .normalized property that is a string, the
              full module name.
        */
        normalize(name, options) {
            return name;
        }

        /*
          Determine the resource address (URL, path, etc.) for the requested
          module name.

          This hook is not called for the main script body executed by a call
          to loader.load(), .eval(), or .evalAsync().  But it is called for all
          imports, including imports in scripts.

          ISSUE:  The resolve hook is where we consult the @ondemand table and
          therefore is where we know whether the resulting address is a module
          or a script.  But it is the fetch hook that is responsible for
          producing that information, passing it to the fulfill callback. Need
          to figure out how the information gets from here to there.

          RESOLVED:  The resolve hook may return a pair {url: "blah", type: "script"},
          per dherman, 2013 April 22.

          ISSUE:  RELATIVE MODULE NAMES.  Suppose we have a module "a/b/c" loaded from
          the url "http://example.com/scripts/a/b/c.js", and it does:
              import "x" as x, "../y" as y, "/z" as z;
          What full module names and urls are generated by the system loader's
          default normalize/resolve behavior?  According to samth, the default
          normalize behavior is to return the name unchanged, so the full
          module names would be "x", "../y", and "/z" respectively.  But samth
          has also said that those aren't valid module names.

          ISSUE:  DEFAULT RESOLVE BEHAVIOR VS. COMMON-SENSE URLS.  Again suppose we
          have loaded a module "a/b/c" from the url
          "http://example.com/scripts/a/b/c.js", and it contains
              import "x" as x;
          The system loader's default resolve behavior produces the full name "x"
          and the url "http://example.com/scripts/a/b/x.js", I think we have a problem.

          ISSUE: DEFAULT RESOLVE BEHAVIOR VS. CONCATENATION.  Consider a module
          "a/b/c", loaded in two different ways: first, as a module, from the
          url "http://example.com/scripts/a/b/c.js"; second, "a/b/c" is defined
          in a script loaded from the url "http://example.com/scripts/all.js"
          which contains several modules.  It is the same module either way.
          And it contains:
              import "x" as x;
          which triggers these resolve hook calls:
              // case 1
              loader.resolve("x", {referer: {name: "a/b/c",
                                             url: "http://example.com/scripts/a/b/c.js"}})
              // case 2
              loader.resolve("x", {referer: {name: "a/b/c",
                                             url: "http://example.com/scripts/all.js"}})

          It is hard to imagine these two calls (or whatever else the default
          behavior is) returning the same URL for x, which is too bad if we
          want to support concatenation.  Perhaps a Referer object should also
          contain a .type property? :-P
        */
        resolve(normalized, options) {
            if (this.@locations === undefined) {
                var locations = $MapNew();
                for (let [url, contents] of $MapIterator(this.@ondemand)) {
                    if (typeof contents === "string") {
                        $MapSet(locations, contents, url);
                    } else {
                        // Assume contents is an iterable.
                        for (var name of contents)
                            $MapSet(locations, name, url);
                    }
                }
                this.@locations = locations;
            }

            let address = $MapGet(this.@locations, normalized);
            let found = address !== undefined;
            if (!found) {
                // Yes, really add ".js" here, per samth 2013 April 22.
                address = normalized + ".js";
            }

            /*
              ISSUE: This $ToAbsoluteURL call, could be part of the default
              fetch behavior, allowing subclasses the luxury of omitting it.
              Or it could stay here, allowing subclasses the luxury of assuming
              super.resolve() is going to return an absolute URL.  Or it could
              be in both places.

              RESOLVED: Both places, per samth 2013 April 22. The default
              resolve behavior should try to return an absolute URL; if the
              user overrides it to return a relative URL, the default fetch
              behavior should cope sensibly.

              TODO: implement that.

              TODO: @baseURL isn't the right base url to use.
            */
            address = $ToAbsoluteURL(this.@baseURL, address);

            if (found && typeof $MapGet(this.@ondemand, address) !== 'string')
                return {address, type: "script"};

            return address;
        }

        /*
          Asynchronously fetch the requested source from the given address
          (produced by the resolve hook).

          This hook is called for all modules and scripts whose source is not
          directly provided by the caller.  It is not called for the script
          bodies executed by loader.eval() and .evalAsync(), since those do not
          need to be fetched.  loader.evalAsync() can trigger this hook, for
          modules imported by the script.  loader.eval() is synchronous and
          thus never triggers the fetch hook.
        */
        fetch(address, fulfill, fail, skip, options) {
            return $DefaultFetch(address, fulfill, fail, options.normalized,
                                 options.referer);
        }

        /*
          Optionally translate src from some other language into JS.

          This hook is called for all modules and scripts.  The default
          implementation does nothing and returns src unchanged.
        */
        translate(src, options) {
            return src;
        }

        /*
          The link hook allows a loader to optionally override the default
          linking behavior.  It can do this in one of several ways:

          - eagerly providing a full Module instance object;

          - declaring external dependencies and a factory function for
            executing the module body once the dependencies are resolved;

          - doing the same but also specifying the module's export set; or

          - choosing not to override the default linking for the given module
            by returning undefined.

          If the hook does not specify a module's exports, the module is
          dynamically linked.  In this case, it is executed during the linking
          process.  First all of its dependencies are executed and linked, and
          then passed to the relevant execute function.  Then the resulting
          module is linked iwth the downstream dependencies.  This requires
          incremental linking when such modules are present, but it ensures
          that modules implemented with standard source-level module
          declarations can still be statically validated.

          The default implementation does nothing and returns undefined.
        */
        link(src, options) {
        }

        @addLinkageUnitForModule(normalized, status, done, fail) {
            let unit = new LinkageUnit(this, done, fail);
            unit.addModuleAndDependencies(normalized, status); // ???
            status.soloLinkageUnit = unit;

            // Implementation issue: LinkageUnits might need to have numeric
            // ids to support time-ordering them, and they might need to be in
            // a doubly linked list to support fast append and remove
            // operations.
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
      linkage units can be in-flight at once.
    */


    /*
      A LinkageUnit implements a single call to loader.evalAsync(), .load(), or .import().

      Not every call to .import() produces a new LinkageUnit; if the desired
      module is already loading, we can simply add callbacks to the existing
      LinkageUnit.
    */
    class LinkageUnit {
        constructor(loader, done, fail) {
            // TODO: make LinkageUnits not inherit from Object.prototype, for isolation;
            // or else use symbols for all these. :-P
            this.loader = loader;
            this.doneCallbacks = [done];
            this.failCallbacks = [fail];
            // TODO: finish overall load state
        }

        addListeners(done, fail) {
            $ArrayPush(this.doneCallbacks, done);
            $ArrayPush(this.failCallbacks, fail);
        }

        addModuleAndDependencies(name, modst) {
            // TODO
        }

        onLinkedModule(mod) {
            // TODO
        }
    }

    /*
      A ModuleStatus object is an entry in a Loader's "loading" map.

      It is in one of three states:

      1. Loading: Source is not available yet.

          .status === "loading"
          .listeners is an Array of LinkageUnits

      2. Waiting: Source is available and has been "translated"; dependencies have
      been identified. But the module hasn't been linked or executed yet. We are
      waiting for dependencies.

      This pseudo-implementation treats the Module object as already existing at
      this point (except for factory-made modules). But it has not been linked and
      thus must not be exposed to script yet.

      The "waiting" state says nothing about the status of the dependencies; they
      may all be "ready" and yet there may not be any LinkageUnit that's ready to
      link and execute this module. The LinkageUnit may be waiting for unrelated
      dependencies to load.

          .status === "waiting"
          .module is a Module or null
          .factory is a callable object or null
          .dependencies is an Array of strings

          Exactly one of [.module, .factory] is non-null.

      3. Ready: The module has been linked. A Module object exists. It may have
      already executed; it may be executing now; but it may only have been
      scheduled to execute and we're in the middle of executing some other module
      (a dependency or something totally unrelated). Or the module may be
      factory-made in which case there is nothing left to execute.

          .status === "ready"
          .module is a Module

    */
    class ModuleStatus {
        /*
          A module entry begins in the "loading" state.
        */
        constructor() {
            this.status = "loading";
            this.listeners = [];
            this.module = null;
            this.factory = null;
            this.dependencies = null;

            // The LinkageUnit, if any, whose sole purpose is to load this
            // module.  (As opposed to other LinkageUnits that are trying to
            // load modules or scripts which directly or indirectly import on
            // this one.)
            this.soloLinkageUnit = null;
        }

        /*
          This is called when a module passes the last loader hook (the .link hook).
          It transitions from "loading" to "waiting".
        */
        onLoad(mod, fac, dependencyNames) {
            $Assert(this.status === "loading");
            $Assert(mod !== null || fac !== null)
            $Assert(mod === null || fac === null);

            this.status = "waiting";
            this.listeners = undefined;
            this.module = mod;
            this.factory = fac;
            this.dependencies = dependencyNames;
        }

        /*
          This is called when a non-factory-made ES6 module has been linked to its
          dependencies.  The module transitions from "waiting" to "ready" and
          becomes visible via loader.get().

          The module has not necessarily executed yet, so all its fields may be
          uninitialized. In fact, while the module itself is linked, it may be
          linked (directly or indirectly) to one or more modules that are not yet
          linked!  This means that even though onLink() makes the Module visible,
          it is still unsafe to expose the Module to scripts.  Callers must
          therefore take care not to allow any user code to execute until all
          transitive dependencies have been linked.

          XXX TODO: This is stupid; I can do an extra loop over the array of
          pending modules to avoid ever being in this ridiculous unsafe state.
        */
        onLink() {
            $Assert(this.status === "waiting");
            $Assert(this.module !== null);
            $Assert(this.factory === null);
            this.status = "ready";
            this.factory = undefined;
            this.dependencies = null;
        }

        /*
          This is called when the factory is called and successfully returns a
          Module object.
        */
        onManufacture(mod) {
            $Assert(this.status === "waiting");
            $Assert(this.module === null);
            $Assert(this.factory !== null);
            this.status = "ready";
            this.module = mod;
            this.factory = null;
            this.dependencies = null;
        }

        /*
          ISSUE (NOT YET RIPE): ERROR HANDLING. Suppose I do
              loader.evalAsync('import "x"; import "y";')
          and partway through the process of loading the many dependencies
          of "x" and "y", something fails. Now what?

          Proposal: Every error that can occur throughout the process is
          related to some specific Module (in loader.@modules) or in-flight
          ModuleStatus (in loader.@loading). When an error occurs:

           1. Find the set of LinkageUnits that needed that module, the one
              that triggered the error.  We are going to fail all these
              LinkageUnits.

           2. Find all in-flight modules (in loader.@loading) that are not
              needed by any LinkageUnit other than those found in step 1.
              (Note that this may or may not include the module that triggered
              the error, because that module may or may not be in-flight; it
              might have thrown while loading or while executing.)  Mark these
              in-flight modules dead and remove them from loader.@loading.  If
              any are in "loading" state, neuter the fetch hook's
              fulfill/reject/skip callbacks so that they become no-ops.

           3. Call the fail hooks for each LinkageUnit found in step 1.

              ISSUE (NOT YET RIPE):  in any particular order?  We can spec the
              order to be the order of the import()/load()/asyncEval() calls,
              wouldn't be hard.

          After that, we drop the LinkageUnits and they become garbage.

          Note that any modules that are already linked and committed to
          the module registry (loader.@modules) are unaffected by the error.
        */

        /*
          For reference, here are all the kinds of errors that can
          occur. This list is meant to be exhaustive.

          - For each module, we call all five loader hooks, any of which
            can throw or return an invalid value.

          - The normalize, resolve, and link hooks may return objects that are
            then destructured.  They could return objects that throw from a
            getter or Proxy trap while being destructured.

          - The fetch hook can report an error via the reject() callback
            (and perhaps skip() though it's not clear to me what that is).

          - We can fetch bad code and get a SyntaxError trying to compile
            it.

          - During linking, we can find that a factory-made module is
            involved in an import cycle. This is an error.

          - A "static" linking error: a script or module X tries to import
            a binding from a module Y that isn't among Y's exports.

          - A factory function can throw or return an invalid value.

          - Execution of a module body or a script can throw.
        */

        /*
          Notify that loading failed.
        */
        fail(exc) {
            $Assert(this.status === "loading");
            
            throw fit;  // TODO
        }

        /*
          Cancel a load because the fetch hook, instead of loading source code,
          went ahead and used eval() or loader.set() to put a finished module
          into the registry.

          (Used by the mischiefManaged callback in Loader.@importFor().)
        */
        cancel() {
            throw fit;  // TODO
        }
    }
}

/*
  ISSUE: what if someone executes some code that says
      module "A" {}
  while "A" is in-flight?

  That is, suppose a ModuleStatus for "A" is in loader.@loading when a script
  executes that contains a module-declaration for "A". Is that allowed?
  What happens when the in-flight module finishes loading?

  RESOLVED: Whichever one happens first is allowed, and the second one is an
  error. per samth, 2013 April 22.
*/

/*
  ISSUE:

  module "A" { import "B" as B; }
  alert("got here");

  Note that toplevel does not import "A".  Suppose we load and run this script.
  Does it load B.js before executing the alert?  I think it does, but doesn't
  run either module until one is imported.

  RESOLVED:  Yes. When we load a script, we add all its modules and their
  dependencies to the same linkage unit.  per samth, 2013 April 22.
*/
