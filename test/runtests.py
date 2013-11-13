import sys, os
PY_LIB_DIR = os.path.abspath("../../mi/js/src/tests/lib")
sys.path.insert(0, PY_LIB_DIR)
import jittests
TEST_DIR = jittests.TEST_DIR = os.path.abspath(os.path.dirname(__file__))
TEST_SCRIPT = os.path.abspath("../../mi/js/src/jit-test/jit_test.py")
SRC_DIR = os.path.dirname(TEST_DIR)
PROMISE_JS = os.path.join(SRC_DIR, "Promise.js")
LOADER_JS = os.path.join(SRC_DIR, "Loader.js")
sys.argv = [TEST_SCRIPT, "-s", "-o", "--args=-f '{}' -f '{}'".format(PROMISE_JS, LOADER_JS), os.environ["JS"]] + sys.argv[1:]
execfile(TEST_SCRIPT)
