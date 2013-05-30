# ES6 modules rationale

## Why JS is different

Most module systems assume access to a fast filesystem. They use blocking
I/O. They search many directories looking for files.

Obviously that won't fly on the Web. We need a module system that works
asynchronously.

Things can happen in an asynchronous module system that can't happen in
synchronous systems.

  * Dependencies can load in parallel.
  * While dependencies are loading for one script, another script can run.
    And that script may share dependencies with the first one.

Also, the precise behavior of the system must be specified in some detail, to
minimize cross-browser compatibility gotchas.


## Module use cases

### Sharing and reusing code (without full-duplex coordination)

Use case: just importing underscore

Use case: coping with dependencies


### Easy development and debugging

Use case: importing a multifile package in source form

Use case: bundling your package for others to use


### Efficient and convenient deployment

Use case: moving your JS to a CDN

Use case: deploying all/several modules in a single file

Use case: updating to a newer version of a third-party package


### Project organization

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
