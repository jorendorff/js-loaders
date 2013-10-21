import sys, os
PY_LIB_DIR = os.path.abspath("../../mi/js/src/tests/lib")
sys.path.insert(0, PY_LIB_DIR)
import jittests
TEST_DIR = jittests.TEST_DIR = os.path.abspath(os.path.dirname(__file__))
TEST_SCRIPT = os.path.abspath("../../mi/js/src/jit-test/jit_test.py")
LOADER_JS = os.path.abspath(os.path.join(TEST_DIR, "..", "Loader.js"))
sys.argv = [TEST_SCRIPT, "-s", "-o", "--args=-f '{}'".format(LOADER_JS), os.environ["JS"]]
execfile(TEST_SCRIPT)
    
