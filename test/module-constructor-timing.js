// new Module(obj) gets the value of each enumerable property of obj at construct time.

var val = 7;
var obj = {
    get x() {
        log += "x";
        return val;
    },
    y: 8
};

var log = "";
var m = new Module(obj);  // obj.x getter is called
assertEq(log, "x");
assertEq(m.x, 7);
assertEq(m.y, 8);

val = 9;
assertEq(m.x, 7);  // obj.x getter is not called again
assertEq(log, "x");

obj.y = 0;
assertEq(m.y, 8);
