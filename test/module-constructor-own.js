// new Module(obj) only exports own properties of obj.

var hits = 0;
var proto = {
    a: 1, 
    get b() {
        hits++;
        throw "FAIL";
    }
};
var obj = Object.create(proto);
obj.x = "good";
var m = new Module(obj);
assertEq(typeof m, "object");
assertEq(m.a, undefined);
assertEq(m.b, undefined);
assertEq(hits, 0);
assertEq(m.x, "good");
assertEq(Object.getOwnPropertyNames(m).join(","), "x");
