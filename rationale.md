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


