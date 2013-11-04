#!/bin/bash

# Activate virtualenv if necessary.
if [ -z "$VIRTUAL_ENV" ]; then
  if [ ! -d scripts/venv ]; then
    echo "Please follow the setup instructions in scripts/README.md before running this script."
    exit 1
  fi
  . scripts/venv/bin/activate
fi

# Enable strict error handling. (We would set this first thing, but
# virtualenv's activate script doesn't cope with it.)
set -eu

# Build the web page.
rm -rf docs
python scripts/schnocco.py Loader.js

# Ship it.
(cd docs && cp Loader.html loaders.html)  # legacy url
(cd docs && rsync -avr --delete . people.mozilla.org:~/public_html/js-loaders/)
