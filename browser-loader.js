// # browser-loader.js - Define browser loader hooks.

"use strict";

// This file shows sample implementations of the browser's loader hooks.  [The
// `Loader` API](./loaders.js), which is standard-track for ECMAScript Edition
// 6, provides hooks so that an implementation or user code can customize the
// import process.
//
// The hooks defined here provide some simple behavior for `import` in the
// browser. The plan is to standardize something like this in a joint effort
// between TC39 and the standard organizations responsible for Web applications
// and so forth.

// P3 ISSUE #21: Determine whether this is a subclass or what.

import {
    $QueueTask,
    $ToAbsoluteURL,
    $FetchTextFromURL
} from "implementation-intrinsics";

// Capabilities that JS provides, but via methods that other code could
// delete or replace.
import {
    $ArrayPush,     // $ArrayPush(arr, v) ~= arr.push(v)
    $MapNew,        // $MapNew() ~= new Map
    $MapGet,        // $MapGet(map, key) ~= map.get(key)
    $MapSet,        // $MapSet(map, key, value) ~= map.set(key, value)
    $MapDelete,     // $MapDelete(map, key) ~= map.delete(key)
    $MapPairs,      // $MapPairs(map) ~= [...map]
    $ObjectKeys,    // $ObjectKeys(obj) ~= Object.keys(obj)
    $StringSplit,   // $StringSplit(s, delim) ~= s.split(delim)
    $TypeError      // $TypeError(msg) ~= new TypeError(msg)
} from "implementation-builtins";

import { System } from "js/loaders";

// **`System.normalize`** - Convert relative module names to full module names.
//
// P1 ISSUE #22:  Make sure hierarchical module names are sufficient for
// packages.
//
// Relative module names are handy for imports within a package.
//
// The syntax for a module name in the browser is:
//
//     module_name = segments
//                 | dot slash segments
//                 | (dot dot slash)+ segments
//
//     segments = segment (slash segment)*
//
//     segment = a nonempty sequence of non-slash characters, but not "." or ".."
//     dot = an ASCII period, "."
//     slash = an ASCII forward slash, "/"
//
// This is not meant to duplicate every crazy trick that relative URI
// references can do, although "." and ".." are treated about the same way
// here as they are in URIs (and filenames generally).
//
// Examples: In module "bacon/streams/basic",
//     "./advanced"   means  "bacon/streams/advanced"
//     "../floods"    means  "bacon/floods"
//     "../../other"  means  "bacon/other"
//
// P2 ISSUE #23: Define syntactic details:
//
// Excess ".." entries are silently discarded. Error instead?
//     "../../../../../overboard" means "overboard"
//
// Unlike URLs, relative module names may not begin with "/", may not
// contain empty segments, may only contain "." and ".." segments at the
// beginning, may not contain multiple "." segments, and may not end with
// "." or "..".
//
System.normalize = function normalize(name, options) {
    if (typeof name !== "string")
        throw $TypeError("module names are strings");

    var segments = $StringSplit(name, "/");

    // A module's name cannot be the empty string.
    if (segments.length == 0)
        throw $TypeError("missing module name");

    // Check for leading dots indicating a relative module name.
    var i = 0;  // current read position within segments
    var rel;    // true if this is a relative module name
    var dotdots = 0; // number of ".." segments scanned
    if (segments[0] == '.') {
        i++;
        if (i === segments.length)
            throw $TypeError("illegal module name: \"" + name + "\"");
        rel = true;
    } else {
        while (segments[i] == '..') {
            i++;
            if (i === segments.length)
                throw $TypeError("illegal module name: \"" + name + "\"");
        }
        rel = (i !== 0);
        dotdots = i;
    }

    // Empty segments are not allowed.
    // "." and ".." are allowed only at the start of a relative name.
    for (var j = i; j < segments.length; j++) {
        if (segments[j] === "" || segments[j] == "." || segments[j] == "..")
            throw $TypeError("illegal module name");
    }

    if (!rel)
        return name;

    // Build a full module name from the relative name.
    var rest = '';
    function append(s) {
        rest = (rest === "") ? s : rest + "/" + s;
    }
    var base = $StringSplit(options.referer.name, "/");
    var stop = base.length - 1 - dotdots;  // This can be negative.
    for (var j = 0; j < stop; j++)  // Treat negative `stop` same as 0.
        append(base[j]);
    for (; i < segments.length; i++)
        append(segments[i]);
    return rest;
};

// **`System.@ondemandTable`** - Maps urls (strings) to resource contents (a
// string, the module name; or an Array of strings, a list of module
// names). Updated by `System.ondemand()`.
System.@ondemandTable = $MapNew();

// **`System.@locations`** - Maps module names to urls, a copy of the data in
// `this.@ondemand` tuned for lookup by module name. (This is purely a
// performance hack, a cache.  Whenever `@ondemandTable` is modified, we
// discard `@locations`.)
System.@locations = undefined;

// **`System.ondemand`** - Browser resolve configuration.
//
// TODO: doc comment here
// 
// P4 ISSUE:  Proposed name for this method: addSources(sources)
//
System.ondemand = function ondemand(sources) {
    let keys = $ObjectKeys(sources);
    for (let i = 0; i < keys.length; i++) {
        let url = keys[i];
        let contents = sources[url];
        if (contents === null) {
            $MapDelete(this.@ondemandTable, url);
        } else if (typeof contents === "string") {
            $MapSet(this.@ondemandTable, url, contents);
        } else {
            // contents must be either null, a string, or an iterable object.
            //
            // Rationale for making a copy of contents rather than
            // keeping the object around: Determinism, exposing fewer
            // implementation details.  Examining a JS object can run
            // arbitrary code.  We want to fire all those hooks now,
            // then store the data in a safer form so user code can't
            // observe when we look at it.
            //
            // P4 ISSUE: confirm iterable vs. array.
            //
            let names = [];
            for (let name of contents) {
                if (typeof name !== "string")
                    throw $TypeError("ondemand: module names must be strings");
                $ArrayPush(names, name);
            }
            $MapSet(this.@ondemandTable, url, names);
        }
    }

    // Destroy the reverse cache.
    this.@locations = undefined;
};

// **`ondemandTableLookup`** - Given a loader and a full module name, find the
// URL of that module in the `ondemand` table.
//
// P4 ISSUE - Expose this function via some public API?
//
function ondemandTableLookup(loader, normalized) {
    if (loader.@locations === undefined) {
        // P5 ISSUE: module names can appear in multiple values in the
        // @ondemand table. This raises the question of ordering of
        // duplicates.
        var locations = $MapNew();
        let pairs = $MapPairs(loader.@ondemand);
        for (let i = 0; i < pairs.length; i++) {
            let [url, contents] = pairs[i];
            if (typeof contents === "string") {
                $MapSet(locations, contents, url);
            } else {
                // contents is an array.
                for (let j = 0; j < contents.length; j++)
                    $MapSet(locations, contents[j], url);
            }
        }
        loader.@locations = locations;
    }

    return $MapGet(loader.@locations, normalized);
}

// **`System.resolve`** - Find a URL for the given module name.
//
// Consult the ondemand table.  If any string value in the table matches the
// module name, return the key.  If any array value in the table contains an
// element that matches the module name, return {address: key, type: "script"}.
//
System.resolve = function resolve(normalized, referer) {
    let address = ondemandTableLookup(this, normalized);
    if (address !== undefined) {
        // Relative URLs in the ondemand table are resolved relative to
        // the baseURL, per samth 2013 April 26.
        address = $ToAbsoluteURL(this.@baseURL, address);
        if (typeof $MapGet(this.@ondemandTable, address) === 'object')
            return {address, type: "script"};
        return address;
    }

    // Otherwise, percent-encode each segment of the module name, add ".js" to the
    // last segment, resolve that relative to this.@baseURL, and return the resolved
    // URL.
    //
    // TODO:  Implement percent-encoding.
    //
    // Add `".js"` here, per samth 2013 April 22.  *Rationale:*  It would be
    // unhelpful to make everyone remove the file extensions from all their
    // scripts.  It would be even worse to make the file extension part of
    // every module name, because module names should be simple strings like
    // `"jquery"` and should not contain particles that only make sense for a
    // particular kind of resolve/load mechanism.  That is, the default resolve
    // hook should not be privileged!  It's honestly not designed to do
    // everything users will want and it is expected that many projects will
    // use a package loader in practice.
    //
    // Both `System.resolve()` and `System.fetch()` call `$ToAbsoluteURL` on
    // the address, per samth 2013 April 22.  *Rationale:*  The default resolve
    // behavior should try to return an absolute URL.  If the user overrides it
    // to return a relative URL, the default fetch behavior should cope with
    // that.
    //
    // P5 ISSUE: Do we care if "." and ".." end up being sent in URL paths?
    // Empty segments ("x//y")?  I think we should try to produce valid URLs or
    // throw, but if <http://foo.bar/x/y//////../../> is a valid URL, fine.
    //
    return $ToAbsoluteURL(this.@baseURL, normalized + ".js");
};

// **`System.fetch`** - Download a resource off the Web.
System.fetch = function fetch(address, fulfill, reject, options) {
    // Both System.resolve() and System.fetch() call $ToAbsoluteURL on the
    // address. See comment in System.resolve above.
    address = $ToAbsoluteURL(this.@baseURL, address);

    // TODO: Implement this in terms of XHR instead of an intrinsic ([issue
    // #24](https://github.com/jorendorff/js-loaders/issues/24)).
    $FetchTextFromURL(address, fulfill, reject);
};
