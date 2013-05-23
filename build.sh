#!/bin/bash

set -eu

# Build the web page.
rm -rf docs
docco --layout classic loaders.js browser-loader.js

# Ship it.
(cd docs && rsync -avr --delete . people.mozilla.org:~/public_html/js-loaders/)
