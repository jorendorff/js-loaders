// The Module constructor requires an object argument.

load(libdir + "asserts.js");
assertThrowsInstanceOf(_ => new Module(), TypeError);
assertThrowsInstanceOf(_ => new Module(undefined), TypeError);
assertThrowsInstanceOf(_ => new Module(null), TypeError);
assertThrowsInstanceOf(_ => new Module(""), TypeError);
assertThrowsInstanceOf(_ => new Module(1729), TypeError);
