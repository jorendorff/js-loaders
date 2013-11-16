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


## Module use cases

### Importing modules others have written

#### Use case: just importing underscore (one module in one file)

It will look like this:

    import _ from "underscore";

The HTML syntax isn&rsquo;t completely worked out yet, but we
anticipate:

    <module>
        import _ from "underscore";
        _.each(["hello", "world"], alert);
    </module>

How it works:

The `<module>` element is like `<script>`, but asynchronous.  Code in a
`<module>` runs as soon as the HTML page is ready *and* any imported
modules have loaded.

The `import` keyword can&rsquo;t be used in a `<script>`. *Rationale:*
The system is asynchronous.  The `import` keyword *never* blocks the
rest of the page from loading and staying responsive.

(If a `<script>` or `eval()` code needs to load a module, it can, using
the asynchronous Loader API, which we&rsquo;ll get to later.)


Use case: importing minimized modularized jquery (a package with many modules in one file)

Use case: importing both Backbone and Underscore, if Backbone imports Underscore

Use case: hosting the code yourself

Use case: importing the same modules from many different web pages on a site


### Easy development and debugging

Use case: importing a multifile package in source form

Use case: bundling your package for others to use


### Efficient and convenient deployment

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
