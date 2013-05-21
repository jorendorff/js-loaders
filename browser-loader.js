/* browser-loader.js - Define browser loader hooks. */

"use strict";

/* P3 ISSUE #21: Determine whether this is a subclass or what. */

import {
    // Embedding features
    $QueueTask,
    $ToAbsoluteURL,
    $FetchTextFromURL,

    // Capabilities that JS provides, but via methods that other code could
    // delete or replace
    $MapGet,            // $MapGet(map, key) ~= map.get(key)
    $ParseInt,          // $ParseInt(s, radix) ~= parseInt(s, radix)
    $StringContains,    // $StringContains(haystack, needle) ~= haystack.contains(needle)
    $StringFromCharCode,  // $StringFromCharCode(u) ~= String.fromCharCode(u)
    $StringMatch,       // $StringMatch(s, regexp) != s.match(regexp)
    $StringReplace,     // $StringReplace(s, regexp, replace) ~= s.replace(regexp, replace)
    $StringSlice,       // $StringSlice(s, start, end) ~= s.slice(start, end)
    $StringSplit,       // $StringSplit(s, delim) ~= s.split(delim)
    $TypeError          // $TypeError(msg) ~= new TypeError(msg)
} from "implementation-intrinsics";

import { System, ondemandTableLookup } from "js/loaders";

// Module names that start with "@" are called at-names.  The only valid
// at-names are URL names, like "@url('mymodule.js')".
//
function IsAtName(name) {
    return name.length > 0 && name[0] === '@';
}

// Regular expressions designed to match the CSS3 Syntax working draft,
// section 4.2, "Tokenization":
//   http://www.w3.org/TR/css3-syntax/#characters
// All groups are non-capturing except the one in css_uri that encloses the
// whole string or unquoted uri.
//
// (Backslashes have been doubled.  JS will parse these as strings, which
// undoubles the backslashes, before concatenating the strings and passing the
// result to the RegExp constructor.)
//
const css_wc = "[\\t\\n\\f\\r ]";
const css_w = css_wc + "*";
const css_nl = "(?:\\n|\\r\\n|\\r|\\f)";
const css_unicode = "\\\\[0-9a-fA-F]{1,6}(\\r\\n|[ \\n\\r\\t\\f])?";
const css_escape = "(?:" + css_unicode + "|\\\\[^\\n\\r\\f0-9a-f])";
const css_string1 = '"(?:[^\\n\\r\\f\\\\"]|\\\\' + css_nl + "|" + css_escape + ')*"';
const css_string2 = "'(?:[^\\n\\r\\f\\\\']|\\\\" + css_nl + "|" + css_escape + ")*'";
const css_string = "(?:" + css_string1 + "|" + css_string2 + ")";
const css_nonascii = "(?:[\\u0080-\\ud7ff\\ue000-\\ufffd]|[\\ud800-\\udbff][\\udc00-\\udfff])";
const css_urlchar = "(?:[!#$%&*-\\[\\]-~]|" + css_nonascii + "|" + css_escape + ")";
const css_uri = "url\\(" + css_w + "(" + css_string + "|" + css_urlchar + "*)" + css_w + "\\)"
const urlRegExp = new RegExp("^" + css_uri + "$");
const escapeRegExp = new RegExp("\\\\" + css_nl + "|" + css_escape, "g");

function Unescape(esc) {
    if ($StringContains("\r\n\f", esc[1]))
        return "";
    else if ($StringContains("0123456789abcdefABCDEF", esc[1]))
        return $StringFromCharCode($ParseInt($StringSlice(esc, 1), 16))
    else
        return esc[1];
}

function ParseURLName(name) {
    let match = $StringMatch(name, urlRegExp);
    if (match === null)
        throw $TypeError("illegal module name: \"" + name + "\"");
    let body = match[1];
    if (body.length > 0 && (body[0] == '"' || body[0] == "'"))
        body = $StringSlice(body, 1, body.length - 1);
    return $StringReplace(body, escapeRegExp, Unescape);
}

/*
  P1 ISSUE #22:  Make sure hierarchical module names are sufficient for
  packages.

  Normalize relative module names based on the referring module's name.

  Relative module names are handy for imports within a package.

  The syntax for a module name in the browser is:

      module_name = segments
                  | dot slash segments
                  | (dot dot slash)+ segments
                  | "@" css_uri

      segments = segment (slash segment)*

      segment = a nonempty sequence of non-slash characters, but not "." or ".."
      dot = an ASCII period, "."
      slash = an ASCII forward slash, "/"

      css_uri = the URI token syntax as defined in CSS2 section 4.1.

  This is not meant to duplicate every crazy trick that relative URI
  references can do, although "." and ".." are treated about the same way
  here as they are in URIs (and filenames generally).

  Examples: In module "bacon/streams/basic",
      "./advanced"   means  "bacon/streams/advanced"
      "../floods"    means  "bacon/floods"
      "../../other"  means  "bacon/other"

  P2 ISSUE #23: Define syntactic details:

  Excess ".." entries are silently discarded. Error instead?
      "../../../../../overboard" means "overboard"

  Unlike URLs, relative module names may not begin with "/", may not
  contain empty segments, may only contain "." and ".." segments at the
  beginning, may not contain multiple "." segments, and may not end with
  "." or "..".
*/
System.normalize = function normalize(name, options) {
    if (typeof name !== "string")
        throw $TypeError("module names are strings");

    if (IsAtName(name)) {
        // As a special case, module names may be URLs in CSS format.
        let url = $ToAbsoluteUrl(options.url, ParseURLName(name));
        return 'url("' + url + '")';
    }

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

/*
  Browser system resolve hook.

  If the module name starts with "@", parse the rest as a URL token. If it
  fails to parse, throw. Otherwise, return that URL (resolved relative to the
  location of the referring script or module, if necessary).

  Otherwise, if there is a relevant entry in the ondemand table, return the
  appropriate result, like Loader.prototype.resolve().

  ISSUE: is this the right order, or should ondemand config trump "@url"?

  Otherwise, percent-encode each segment of the module name, add ".js" to the
  last segment, resolve that relative to this.@baseURL, and return the resolved
  URL.

  TODO: Implement percent-encoding.

  P5 SECURITY ISSUE: Possible security issues related to the browser
  resolve hook:

  - Do we want loader.import(x), where x is untrusted, to be arbitrary
    code execution by default?  If not, ban javascript: URLs.

  - Are data: URLs a problem?

  - Do we care if "." and ".." end up being sent in URL paths?  Empty
    segments ("x//y")?  I think we should try to produce valid URLs or
    throw, but maybe <http://foo.bar/x/y//////../../> is valid.
 */
System.resolve = function resolve(normalized, referer) {
    if (IsAtName(normalized))
        return $ToAbsoluteURL(referer.url, ParseURLName(normalized));

    let address = ondemandTableLookup(this, normalized, referer);
    if (address !== undefined) {
        // Relative URLs in the ondemand table are resolved relative to
        // the baseURL, per samth 2013 April 26.
        address = $ToAbsoluteURL(this.@baseURL, address);
        if (typeof $MapGet(this.@ondemand, address) === 'object')
            return {address, type: "script"};
        return address;
    }

    /*
      Add ".js" here, per samth 2013 April 22.  Rationale:  It would be
      unhelpful to make everyone remove the file extensions from all their
      scripts.  It would be even worse to make the file extension part of every
      module name, because module names should be simple strings like "jquery"
      and should not contain particles that only make sense for a particular
      kind of resolve/load mechanism.  That is, the default resolve hook should
      not be privileged!  It's honestly not designed to do everything users will
      want and it is expected that many projects will use a package loader in
      practice.

      Both System.resolve() and System.fetch() call $ToAbsoluteURL on the
      address, per samth 2013 April 22.  Rationale:  The default resolve
      behavior should try to return an absolute URL.  If the user overrides
      it to return a relative URL, the default fetch behavior should cope
      with that.
    */
    return $ToAbsoluteURL(this.@baseURL, normalized + ".js");
};

// @systemDefaultResolve is used when a resolve hook returns undefined.
// P1 ISSUE #13 proposes removing this feature.
Loader.prototype.@systemDefaultResolve = System.resolve;

System.fetch = function fetch(address, fulfill, reject, done, options) {
    // Both System.resolve() and System.fetch() call $ToAbsoluteURL on the
    // address. See comment in System.resolve above.
    address = $ToAbsoluteURL(this.@baseURL, address);

    $FetchTextFromURL(address, fulfill, reject);
};
