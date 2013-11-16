# ES6 modules rationale

## Why JS is different

**Most module systems assume access to a fast filesystem.** They use
blocking I/O. They search many directories looking for files.

Obviously that won&rsquo;t fly on the Web. We need a module system that
works asynchronously.

Things can happen in an asynchronous module system that can&rsquo;t
happen in synchronous systems.

  * A module&rsquo;s dependencies can load in parallel.

  * While dependencies are loading for one module, the Web page may
    decide to run some code that imports another module.  And those two
    loading modules may share some dependencies.

These cases have affected the design in a few places.

**Many module systems have a single module registry** that every part of
the program uses.  `sys.modules` in Python is an example.  But in a
browser, each `window` must have its own module registry, to prevent Web
pages from tampering with one another or gaining access to one
another&rsquo;s global object and prototype objects.

**Most module systems only have implementations, not full
specifications.**  The precise behavior of the ES6 module system must be
specified in some detail, to minimize cross-browser compatibility
gotchas.


## The system in a nutshell

The module system consists of:

  * an HTML `<module>` element;

  * some new declarative JS syntax (`import`, `export`, and `module`
    keywords); and

  * a new `Loader` builtin constructor with an asynchronous API, for
    loading modules dynamically and for customizing module loading.


## Examples

### Importing modules others have written

#### Use case: just importing underscore (one module in one file)

It will look like this:

    module _ from "underscore";

...followed by code that uses `_`.

The HTML syntax isn&rsquo;t completely worked out yet, but we anticipate
something like:

    <module>
        module _ from "underscore";
        // ... code that uses _ ...
    </module>

How it works:

The `<module>` element is like `<script>`, but asynchronous.  Code in a
`<module>` runs as soon as the HTML page *and* any imported modules have
finished loading.

By default, we expect the module loader will load `"underscore"` from
the relative URL `underscore.js`; this is configurable.

The `import` keyword can&rsquo;t be used in a `<script>`. *Rationale:*
The system is asynchronous.  The `import` keyword *never* blocks the
rest of the page from loading and staying responsive.

(If a `<script>` or `eval()` code needs to load a module, it can, using
the asynchronous Loader API, which we&rsquo;ll get to later.)


#### Use case: importing a module which imports another module

Simple:

    module Backbone from "backbone";

If `"backbone"` contains this:

    module _ from "underscore";

then we load `"underscore"`.  No code runs until all dependencies are
loaded.


#### Use case: hosting the code yourself

You do not have to change any JS code.  In particular, your `import`
declarations, which will likely be scattered across all your JS files,
do not need to change.


Use case: importing minimized modularized jquery (a package with many modules in one file)

Use case: importing the same modules from many different web pages on a site


### Development and debugging

Use case: importing a multifile package in source form

Use case: bundling your package for others to use


### Deployment

#### How to improve load times for modules with dependencies

Recall an earlier example:

    module Backbone from "backbone";

where the `"backbone"` module contains this:

    module _ from "underscore";

Note that this example, as written, causes two network round-trips in
series.  First we load the `"backbone"` module.  When that loads, the
module system sees that Backbone requires Underscore, so we then load
`"underscore"`.

The system can&rsquo;t start loading `"underscore"` until the source
code for `"backbone"` arrives; it simply has no way of knowing what
`"backbone"` imports until it can look at the source code.

Can the extra network round-trip be eliminated?  Yes.  Here are some
ways:

  * **Use HTTP2/SPDY.**  The server will figure out that it should send
    *both* files (Backbone and Underscore) whenever a client asks for
    Backbone.  This is the nicest approach.  It requires no changes to
    your JS or HTML code.

  * **Kick off loads eagerly.**  You can change your JS code to say

        module _ from "underscore";
        module Backbone from "backbone";

    or add this to your HTML code:

        <module name="underscore" src="..."></module>

    Either way, the point is to kick off *all* loads as early as
    possible, so that they can run in parallel rather than in series,
    reducing the total wait time.

  * **Make a bundle.**  You can bundle several modules into a single
    file on the server, and send that to the client eagerly, cutting
    short a bunch of round trips.  Loader hooks make this easy.  We'll
    see an example below.

  * **Use a new kind of URL?**  W3C is considering a "zip URL" feature
    that would be another very easy-to-deploy alternative.

But if your load times are satisfactory for now, you don&rsquo;t need to
do anything.  The system is designed so that *all* these techniques are
easy to deploy after the fact, without significant changes to your
application code.

Use case: moving your JS to a CDN

Use case: deploying all/several modules in a single file

Use case: updating to a newer version of a third-party package


### Project organization

Use case: imports within a package

Use case: loading multiple versions of a module


### Interoperability

Use case: reusing npm/AMD modules/packages

Use case: how node might integrate `import` with npm

Use case: using the same source code in node and the browser


### Advanced topics: Translation

Use case: automatically translating coffeescript source files

Use case: implementing a direct-eval-like feature in terms of JS direct eval


### Advanced topics: Isolation

Use case: running code in a restricted environment. This has several parts.

- isolated globals
- completely controlling what `import` can expose
- avoiding object leaks
