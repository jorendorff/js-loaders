/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//> #### Array.prototype.indexOf ( searchElement [ , fromIndex ] )
//>
//> `indexOf` compares searchElement to the elements of the array, in
//> ascending order, using the Strict Equality Comparison algorithm (11.9.1),
//> and if found at one or more positions, returns the index of the first such
//> position; otherwise, -1 is returned.
//>
//> The optional second argument fromIndex defaults to 0 (i.e. the whole
//> array is searched). If it is greater than or equal to the length of the
//> array, -1 is returned, i.e. the array will not be searched. If it is
//> negative, it is used as the offset from the end of the array to compute
//> fromIndex. If the computed index is less than 0, the whole array will be
//> searched.
//>
//> When the `indexOf` method is called with one or two arguments, the
//> following steps are taken:
//>
function ArrayIndexOf(searchElement/*, fromIndex*/) {
//> 1. Let O be the result of calling ToObject passing the this value
//>    as the argument.
//> 2. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 3. Let lenValue be the result of Get(O, `"length"`).
//> 4. Let len be ToLength(lenValue).
//> 5. ReturnIfAbrupt(len).
    var len = TO_UINT32(O.length);

//> 6. If len is 0, return -1.
    if (len === 0)
        return -1;

//> 7. If argument fromIndex was passed let n be ToInteger(fromIndex);
//>    else let n be 0.
//> 8. ReturnIfAbrupt(n).
    var n = arguments.length > 1 ? ToInteger(arguments[1]) : 0;

//> 9. If n ≥ len, return -1.
    if (n >= len)
        return -1;

//> 10. If n ≥ 0, then
//>     1. Let k be n.
//> 11. Else n<0,
//>     1. Let k be len - abs(n).
//>     2. If k < 0, then let k be 0.
    var k;
    if (n >= 0) {
        k = n;
    } else {
        k = len + n;
        if (k < 0)
            k = 0;
    }

//> 12. Repeat, while k<len
//>     1. Let kPresent be the result of HasProperty(O, ToString(k)).
//>     2. ReturnIfAbrupt(kPresent).
//>     3. If kPresent is **true**, then
//>         1. Let elementK be the result of Get(O, ToString(k)).
//>         2. ReturnIfAbrupt(elementK).
//>         3. Let same be the result of performing Strict Equality Comparison searchElement === elementK.
//>         4. If same is **true**, return k.
//>     4. Increase k by 1.
    for (; k < len; k++) {
        if (k in O && O[k] === searchElement)
            return k;
    }

//> 13. Return -1.
    return -1;
}
//>
//> The `length` property of the `indexOf` method is **1**.
//>
//> NOTE The `indexOf` function is intentionally generic; it does not require
//> that its **this** value be an Array object. Therefore it can be transferred
//> to other kinds of objects for use as a method. Whether the `indexOf`
//> function can be applied successfully to an exotic object that is not an
//> Array is implementation-dependent.
//>


//> #### Array.prototype.lastIndexOf ( searchElement [ , fromIndex ] )
//>
//> `lastIndexOf` compares searchElement to the elements of the array in
//> descending order using the Strict Equality Comparison algorithm (11.9.1),
//> and if found at one or more positions, returns the index of the last such
//> position; otherwise, -1 is returned.
//>
//> The optional second argument fromIndex defaults to the array's length minus
//> one (i.e. the whole array is searched). If it is greater than or equal to
//> the length of the array, the whole array will be searched. If it is
//> negative, it is used as the offset from the end of the array to compute
//> fromIndex. If the computed index is less than 0, -1 is returned.
//>
//> When the `lastIndexOf` method is called with one or two arguments, the following steps are taken:
//>
function ArrayLastIndexOf(searchElement/*, fromIndex*/) {
//> 1. Let O be the result of calling ToObject passing the this value as the argument.
//> 1. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 1. Let lenValue be the result of Get(O, "length")
//> 1. Let len be ToLength(lenValue).
//> 1. ReturnIfAbrupt(len).
    var len = TO_UINT32(O.length);

//> 1. If len is 0, return -1.
    if (len === 0)
        return -1;

//> 1. If argument fromIndex was passed let n be ToInteger(fromIndex); else let n be len-1.
//> 1. ReturnIfAbrupt(n).
    var n = arguments.length > 1 ? ToInteger(arguments[1]) : len - 1;

//> 1. If n ≥ 0, then let k be min(n, len – 1).
//> 1. Else n < 0,
//>     1. Let k be len - abs(n).
    var k;
    if (n > len - 1)
        k = len - 1;
    else if (n < 0)
        k = len + n;
    else
        k = n;

//> 1. Repeat, while k ≥ 0
    for (; k >= 0; k--) {
//>     1. Let kPresent be the result of HasProperty(O, ToString(k)).
//>     1. ReturnIfAbrupt(kPresent).
//>     1. If kPresent is true, then
//>         1. Let elementK be the result of Get(O, ToString(k)).
//>         1. ReturnIfAbrupt(elementK).
//>         1. Let same be the result of performing Strict Equality Comparison
//>            searchElement === elementK.
//>         1. If same is true, return k.
        if (k in O && O[k] === searchElement)
            return k;
//>     1. Decrease k by 1.
    }

//> 1. Return -1.
    return -1;
}
//>
//> The `length` property of the `lastIndexOf` method is **1**.
//>
//> NOTE The `lastIndexOf` function is intentionally generic; it does not
//> require that its **this** value be an Array object. Therefore it can be
//> transferred to other kinds of objects for use as a method. Whether the
//> `lastIndexOf` function can be applied successfully to an exotic object that
//> is not an Array is implementation-dependent.
//>


//> #### Array.prototype.every ( callbackfn [ , thisArg ] )
//>
//> callbackfn should be a function that accepts three arguments and returns a
//> value that is coercible to the Boolean value **true** or **false**. `every`
//> calls callbackfn once for each element present in the array, in ascending
//> order, until it finds one where callbackfn returns **false**. If such an
//> element is found, `every` immediately returns **false**. Otherwise, if
//> callbackfn returned **true** for all elements, `every` will return
//> **true**. callbackfn is called only for elements of the array which
//> actually exist; it is not called for missing elements of the array.
//>
//> If a thisArg parameter is provided, it will be used as the this value for
//> each invocation of callbackfn. If it is not provided, **undefined** is used
//> instead.
//>
//> callbackfn is called with three arguments: the value of the element, the
//> index of the element, and the object being traversed.
//>
//> `every` does not directly mutate the object on which it is called but the
//> object may be mutated by the calls to callbackfn.
//>
//> The range of elements processed by `every` is set before the first call to
//> callbackfn. Elements which are appended to the array after the call to
//> `every` begins will not be visited by callbackfn. If existing elements of
//> the array are changed, their value as passed to callbackfn will be the
//> value at the time `every` visits them; elements that are deleted after the
//> call to `every` begins and before being visited are not visited. `every`
//> acts like the "for all" quantifier in mathematics. In particular, for an
//> empty array, it returns true.
//>
//> When the `every` method is called with one or two arguments, the following
//> steps are taken:
//>
function ArrayEvery(callbackfn/*, thisArg*/) {
//> 1. Let O be the result of calling ToObject passing the this value as the argument.
//> 1. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 1. Let lenValue be the result of Get(O, "length")
//> 1. Let len be ToLength(lenValue).
//> 1. ReturnIfAbrupt(len).
    var len = TO_UINT32(O.length);

//> 1. If IsCallable(callbackfn) is false, throw a **TypeError** exception.
    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.every');
    if (!IsCallable(callbackfn))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, callbackfn));

//> 1. If thisArg was supplied, let T be thisArg; else let T be **undefined**.
    var T = arguments.length > 1 ? arguments[1] : void 0;

//> 1. Let k be 0.
//> 1. Repeat, while k < len
    for (var k = 0; k < len; k++) {
//>     1. Let Pk be ToString(k).
//>     1. Let kPresent be the result of HasProperty(O, Pk).
//>     1. ReturnIfAbrupt(kPresent).
//>     1. If kPresent is true, then
        if (k in O) {
//>         1. Let kValue be the result of Get(O, Pk).
//>         1. ReturnIfAbrupt(kValue).
//>         1. Let testResult be the result of calling the [[Call]] internal
//>            method of callbackfn with T as <var>thisArgument</var> and a
//>            List containing kValue, k, and O as <var>argumentsList</var>.
//>         1. ReturnIfAbrupt(testResult).
//>         1. If ToBoolean(testResult) is false, return false.
            if (!callFunction(callbackfn, T, O[k], k, O))
                return false;
        }
//>     1. Increase k by 1.
    }

//> 1. Return true.
    return true;
}
//>
//> The `length` property of the `every` method is **1**.
//>
//> NOTE The `every` function is intentionally generic; it does not require
//> that its **this** value be an Array object. Therefore it can be transferred
//> to other kinds of objects for use as a method. Whether the `every` function
//> can be applied successfully to an exotic object that is not an Array is
//> implementation-dependent.
//>


//>#### Array.prototype.some ( callbackfn [ , thisArg ] )
//>
//> callbackfn should be a function that accepts three arguments and returns a
//> value that is coercible to the Boolean value **true** or **false**. `some`
//> calls callbackfn once for each element present in the array, in ascending
//> order, until it finds one where callbackfn returns **true**. If such an
//> element is found, `some` immediately returns **true**. Otherwise, `some`
//> returns **false**. callbackfn is called only for elements of the array
//> which actually exist; it is not called for missing elements of the array.
//>
//> If a thisArg parameter is provided, it will be used as the this value for
//> each invocation of callbackfn. If it is not provided, **undefined** is used
//> instead.
//>
//> callbackfn is called with three arguments: the value of the element,
//> the index of the element, and the object being traversed.
//>
//> `some` does not directly mutate the object on which it is called but the
//> object may be mutated by the calls to callbackfn.
//>
//> The range of elements processed by `some` is set before the first call to
//> callbackfn. Elements that are appended to the array after the call to
//> `some` begins will not be visited by callbackfn. If existing elements of
//> the array are changed, their value as passed to callbackfn will be the
//> value at the time that `some` visits them; elements that are deleted after
//> the call to `some` begins and before being visited are not visited. `some`
//> acts like the "exists" quantifier in mathematics. In particular, for an
//> empty array, it returns **false**.
//>
//> When the `some` method is called with one or two arguments, the following
//> steps are taken:
function ArraySome(callbackfn/*, thisArg*/) {
//> 1. Let O be the result of calling ToObject passing the this value as the
//>    argument.
//> 1. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 1. Let lenValue be the result of Get(O, `"length"`).
//> 1. Let len be ToLength(lenValue).
//> 1. ReturnIfAbrupt(len).
    var len = TO_UINT32(O.length);

//> 1. If IsCallable(callbackfn) is **false**, throw a **TypeError** exception.
    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.some');
    if (!IsCallable(callbackfn))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, callbackfn));

//> 1. If thisArg was supplied, let T be thisArg; else let T be **undefined**.
    var T = arguments.length > 1 ? arguments[1] : void 0;

//> 1. Let k be 0.
//> 1. Repeat, while k < len
    for (var k = 0; k < len; k++) {
//>     1. Let Pk be ToString(k).
//>     1. Let kPresent be the result of HasProperty(O, Pk).
//>     1. ReturnIfAbrupt(kPresent).
//>     1. If kPresent is **true**, then
        if (k in O) {
//>         1. Let kValue be the result of Get(O, Pk).
//>         1. ReturnIfAbrupt(kValue).
//>         1. Let testResult be the result of calling the [[Call]] internal
//>            method of callbackfn with T as <var>thisArgument</var> and a
//>            List containing kValue, k, and O as <var>argumentsList</var>.
//>         1. ReturnIfAbrupt(testResult).
//>         1. If ToBoolean(testResult) is **true**, return **true**.
            if (callFunction(callbackfn, T, O[k], k, O))
                return true;
        }
//>     1. Increase k by 1.
    }

//> 1. Return **false**.
    return false;
}
//>
//> The `length` property of the `some` method is **1**.
//>
//> NOTE The `some` function is intentionally generic; it does not require that
//> its **this** value be an Array object. Therefore it can be transferred to
//> other kinds of objects for use as a method. Whether the `some` function can
//> be applied successfully to an exotic object that is not an Array is
//> implementation-dependent.
//>


//> #### Array.prototype.forEach ( callbackfn [ , thisArg ] )
//>
//> callbackfn should be a function that accepts three arguments. `forEach`
//> calls callbackfn once for each element present in the array, in ascending
//> order. callbackfn is called only for elements of the array which actually
//> exist; it is not called for missing elements of the array.
//>
//> If a thisArg parameter is provided, it will be used as the this value for
//> each invocation of callbackfn. If it is not provided, **undefined** is used
//> instead.
//>
//> callbackfn is called with three arguments: the value of the element, the
//> index of the element, and the object being traversed.
//>
//> `forEach` does not directly mutate the object on which it is called but the
//> object may be mutated by the calls to callbackfn.
//>
//> The range of elements processed by `forEach` is set before the first call
//> to callbackfn. Elements which are appended to the array after the call to
//> `forEach` begins will not be visited by callbackfn. If existing elements of
//> the array are changed, their value as passed to callback will be the value
//> at the time `forEach` visits them; elements that are deleted after the call
//> to `forEach` begins and before being visited are not visited.
//>
//> When the `forEach` method is called with one or two arguments, the
//> following steps are taken:
//>
function ArrayForEach(callbackfn/*, thisArg*/) {
//> 1. Let O be the result of calling ToObject passing the this value as the
//>    argument.
//> 1. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 1. Let lenValue be the result of Get(O, `"length"`).
//> 1. Let len be ToLength(lenValue).
//> 1. ReturnIfAbrupt(len).
    var len = TO_UINT32(O.length);

//> 1. If IsCallable(callbackfn) is **false**, throw a **TypeError** exception.
    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.forEach');
    if (!IsCallable(callbackfn))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, callbackfn));

//> 1. If thisArg was supplied, let T be thisArg; else let T be **undefined**.
    var T = arguments.length > 1 ? arguments[1] : void 0;

//> 1. Let k be 0.
//> 1. Repeat, while k < len
    for (var k = 0; k < len; k++) {
//>     1. Let Pk be ToString(k).
//>     1. Let kPresent be the result of HasProperty(O, Pk).
//>     1. ReturnIfAbrupt(kPresent).
//>     1. If kPresent is **true**, then
        if (k in O) {
//>         1. Let kValue be the result of Get(O, Pk).
//>         1. ReturnIfAbrupt(kValue).
//>         1. Let funcResult be the result of calling the [[Call]] internal
//>            method of callbackfn with T as <var>thisArgument</var> and a
//>            List containing kValue, k, and O as <var>argumentsList</var>.
//>         1. ReturnIfAbrupt(funcResult).
            callFunction(callbackfn, T, O[k], k, O);
        }
//>     1. Increase k by 1.
    }

//> 1. Return **undefined**.
    return void 0;
}
//>
//> The length property of the `forEach` method is **1**.
//>
//> NOTE The `forEach` function is intentionally generic; it does not require
//> that its **this** value be an Array object. Therefore it can be transferred
//> to other kinds of objects for use as a method. Whether the `forEach`
//> function can be applied successfully to an exotic object that is not an
//> Array is implementation-dependent.
//>


function ArrayMap(callbackfn/*, thisArg*/) {
    var O = ToObject(this);

    var len = TO_UINT32(O.length);

    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.map');
    if (!IsCallable(callbackfn))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, callbackfn));

    var T = arguments.length > 1 ? arguments[1] : void 0;

    var A = NewDenseArray(len);

    for (var k = 0; k < len; k++) {
        if (k in O) {
            var mappedValue = callFunction(callbackfn, T, O[k], k, O);
            UnsafePutElements(A, k, mappedValue);
        }
    }

    return A;
}


/*
#### Array.prototype.reduce ( callbackfn [ , initialValue ] )

callbackfn should be a function that takes four arguments. reduce calls the callback, as a function, once for each element present in the array, in ascending order.

callbackfn is called with four arguments: the previousValue (or value from the previous call to callbackfn), the currentValue (value of the current element), the currentIndex, and the object being traversed. The first time that callback is called, the previousValue and currentValue can be one of two values. If an initialValue was provided in the call to reduce, then previousValue will be equal to initialValue and currentValue will be equal to the first value in the array. If no initialValue was provided, then previousValue will be equal to the first value in the array and currentValue will be equal to the second. It is a TypeError if the array contains no elements and initialValue is not provided.

reduce does not directly mutate the object on which it is called but the object may be mutated by the calls to callbackfn.

The range of elements processed by reduce is set before the first call to callbackfn. Elements that are appended to the array after the call to reduce begins will not be visited by callbackfn. If existing elements of the array are changed, their value as passed to callbackfn will be the value at the time reduce visits them; elements that are deleted after the call to reduce begins and before being visited are not visited.

When the reduce method is called with one or two arguments, the following steps are taken:

    Let O be the result of calling ToObject passing the this value as the argument.
    ReturnIfAbrupt(O).
    Let lenValue be the result of Get(O, "length").
    Let len be ToLength(lenValue).
    ReturnIfAbrupt(len).
    If IsCallable(callbackfn) is false, throw a TypeError exception.
    If len is 0 and initialValue is not present, throw a TypeError exception.
    Let k be 0.
    If initialValue is present, then
        Set accumulator to initialValue.
    Else initialValue is not present,
        Let kPresent be false.
        Repeat, while kPresent is false and k < len
            Let Pk be ToString(k).
            Let kPresent be the result of HasProperty(O, Pk).
            ReturnIfAbrupt(kPresent).
            If kPresent is true, then
                Let accumulator be the result of Get(O, Pk).
                ReturnIfAbrupt(accumulator).
            Increase k by 1.
        If kPresent is false, throw a TypeError exception.
    Repeat, while k < len
        Let Pk be ToString(k).
        Let kPresent be the result of HasProperty(O, Pk).
        ReturnIfAbrupt(kPresent).
        If kPresent is true, then
            Let kValue be the result of Get(O, Pk).
            ReturnIfAbrupt(kValue).
            Let accumulator be the result of calling the [[Call]] internal method of callbackfn with undefined as <var>thisArgument</var> and a List containing accumulator, kValue, k, and O as <var>argumentsList</var>.
            ReturnIfAbrupt(accumulator).
        Increase k by 1.
    Return accumulator.

The length property of the reduce method is 1.

NOTE The reduce function is intentionally generic; it does not require that its this value be an Array object. Therefore it can be transferred to other kinds of objects for use as a method. Whether the reduce function can be applied successfully to an exotic object that is not an Array is implementation-dependent.
*/
function ArrayReduce(callbackfn/*, initialValue*/) {
    var O = ToObject(this);

    var len = TO_UINT32(O.length);

    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.reduce');
    if (!IsCallable(callbackfn))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, callbackfn));

    var k = 0;

    var accumulator;
    if (arguments.length > 1) {
        accumulator = arguments[1];
    } else {
        if (len === 0)
            ThrowError(JSMSG_EMPTY_ARRAY_REDUCE);
        var kPresent = false;
        for (; k < len; k++) {
            if (k in O) {
                accumulator = O[k];
                kPresent = true;
                k++;
                break;
            }
        }
        if (!kPresent)
            ThrowError(JSMSG_EMPTY_ARRAY_REDUCE);
    }

    for (; k < len; k++) {
        if (k in O) {
            accumulator = callbackfn(accumulator, O[k], k, O);
        }
    }

    return accumulator;
}

/*
Array.prototype.reduceRight ( callbackfn [ , initialValue ] )

callbackfn should be a function that takes four arguments. reduceRight calls the callback, as a function, once for each element present in the array, in descending order.

callbackfn is called with four arguments: the previousValue (or value from the previous call to callbackfn), the currentValue (value of the current element), the currentIndex, and the object being traversed. The first time the function is called, the previousValue and currentValue can be one of two values. If an initialValue was provided in the call to reduceRight, then previousValue will be equal to initialValue and currentValue will be equal to the last value in the array. If no initialValue was provided, then previousValue will be equal to the last value in the array and currentValue will be equal to the second-to-last value. It is a **TypeError** if the array contains no elements and initialValue is not provided.

reduceRight does not directly mutate the object on which it is called but the object may be mutated by the calls to callbackfn.

The range of elements processed by reduceRight is set before the first call to callbackfn. Elements that are appended to the array after the call to reduceRight begins will not be visited by callbackfn. If existing elements of the array are changed by callbackfn, their value as passed to callbackfn will be the value at the time reduceRight visits them; elements that are deleted after the call to reduceRight begins and before being visited are not visited.

When the reduceRight method is called with one or two arguments, the following steps are taken:

    Let O be the result of calling ToObject passing the this value as the argument.
    ReturnIfAbrupt(O).
    Let lenValue be the result of Get(O, "length").
    Let len be ToLength(lenValue).
    ReturnIfAbrupt(len).
    If IsCallable(callbackfn) is false, throw a **TypeError** exception.
    If len is 0 and initialValue is not present, throw a **TypeError** exception.
    Let k be len-1.
    If initialValue is present, then
        Set accumulator to initialValue.
    Else initialValue is not present,
        Let kPresent be false.
        Repeat, while kPresent is false and k ≥ 0
            Let Pk be ToString(k).
            Let kPresent be the result of HasProperty(O, Pk).
            ReturnIfAbrupt(kPresent).
            If kPresent is true, then
                Let accumulator be the result of Get(O, Pk).
                ReturnIfAbrupt(accumulator).
            Decrease k by 1.
        If kPresent is false, throw a **TypeError** exception.
    Repeat, while k ≥ 0
        Let Pk be ToString(k).
        Let kPresent be the result of HasProperty(O, Pk).
        ReturnIfAbrupt(kPresent).
        If kPresent is true, then
            Let kValue be the result of Get(O, Pk).
            ReturnIfAbrupt(kValue).
            Let accumulator be the result of calling the [[Call]] internal method of callbackfn with **undefined** as <var>thisArgument</var> and a List containing accumulator, kValue, k, and O as <var>argumentsList</var>.
            ReturnIfAbrupt(accumulator).
        Decrease k by 1.
    Return accumulator.

The length property of the reduceRight method is 1.

NOTE The reduceRight function is intentionally generic; it does not require that its **this** value be an Array object. Therefore it can be transferred to other kinds of objects for use as a method. Whether the reduceRight function can be applied successfully to an exotic object that is not an Array is implementation-dependent.
*/
function ArrayReduceRight(callbackfn/*, initialValue*/) {
    var O = ToObject(this);

    var len = TO_UINT32(O.length);

    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.reduce');
    if (!IsCallable(callbackfn))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, callbackfn));

    var k = len - 1;

    var accumulator;
    if (arguments.length > 1) {
        accumulator = arguments[1];
    } else {
        if (len === 0)
            ThrowError(JSMSG_EMPTY_ARRAY_REDUCE);
        var kPresent = false;
        for (; k >= 0; k--) {
            if (k in O) {
                accumulator = O[k];
                kPresent = true;
                k--;
                break;
            }
        }
        if (!kPresent)
            ThrowError(JSMSG_EMPTY_ARRAY_REDUCE);
    }

    for (; k >= 0; k--) {
        if (k in O) {
            accumulator = callbackfn(accumulator, O[k], k, O);
        }
    }

    return accumulator;
}

//> #### Array.prototype.find ( predicate , thisArg = undefined )
//>
//> predicate should be a function that accepts three arguments and returns a
//> value that is coercible to the Boolean value **true** or **false**. `find`
//> calls predicate once for each element present in the array, in ascending
//> order, until it finds one where predicate returns **true**. If such an
//> element is found, `find` immediately returns that element value. Otherwise,
//> `find` returns **undefined**. predicate is called only for elements of the
//> array which actually exist; it is not called for missing elements of the
//> array.
//>
//> If a thisArg parameter is provided, it will be used as the this value for
//> each invocation of predicate. If it is not provided, **undefined** is used
//> instead.
//>
//> predicate is called with three arguments: the value of the element, the
//> index of the element, and the object being traversed.
//>
//> `find` does not directly mutate the object on which it is called but the
//> object may be mutated by the calls to predicate.
//>
//> The range of elements processed by `find` is set before the first call to
//> callbackfn. Elements that are appended to the array after the call to
//> `find` begins will not be visited by callbackfn. If existing elements of
//> the array are changed, their value as passed to predicate will be the value
//> at the time that `find` visits them; elements that are deleted after the
//> call to `find` begins and before being visited are not visited.
//>
//> When the `find` method is called with one or two arguments, the following
//> steps are taken:
//>
function ArrayFind(predicate/*, thisArg*/) {
//> 1. Let O be the result of calling ToObject passing the this value as the
//>    argument.
//> 1. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 1. Let lenValue be the result of Get(O, "length").
//> 1. Let len be ToLength(lenValue).
//> 1. ReturnIfAbrupt(len).
    var len = ToInteger(O.length);

//> 1. If IsCallable(predicate) is **false**, throw a **TypeError** exception.
    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.find');
    if (!IsCallable(predicate))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, predicate));

//> 1. If thisArg was supplied, let T be thisArg; else let T be **undefined**.
    var T = arguments.length > 1 ? arguments[1] : undefined;

//> 1. Let k be 0.
//> 1. Repeat, while k < len
    /* Note: this will hang in some corner-case situations, because of IEEE-754 numbers'
     * imprecision for large values. Example:
     * var obj = { 18014398509481984: true, length: 18014398509481988 };
     * Array.prototype.find.call(obj, () => true);
     */
    for (var k = 0; k < len; k++) {
//>     1. Let Pk be ToString(k).
//>     1. Let kPresent be the result of HasProperty(O, Pk).
//>     1. ReturnIfAbrupt(kPresent).
//>     1. If kPresent is **true**, then
        if (k in O) {
//>         1. Let kValue be the result of Get(O, Pk).
//>         1. ReturnIfAbrupt(kValue).
            var kValue = O[k];
//>         1. Let testResult be the result of calling the [[Call]] internal
//>            method of predicate with T as <var>thisArgument</var> and a List
//>            containing kValue, k, and O as <var>argumentsList</var>.
//>         1. ReturnIfAbrupt(testResult).
//>         1. If ToBoolean(testResult) is **true**, return kValue.
            if (callFunction(predicate, T, kValue, k, O))
                return kValue;
        }
//>     1. Increase k by 1.
    }

//> 1. Return **undefined**.
    return undefined;
}
//>
//> The length property of the `find` method is 1.
//>
//> NOTE The `find` function is intentionally generic; it does not require that
//> its **this** value be an Array object. Therefore it can be transferred to
//> other kinds of objects for use as a method. Whether the `find` function can
//> be applied successfully to an exotic object that is not an Array is
//> implementation-dependent.


//> #### Array.prototype.findIndex ( predicate , thisArg = undefined )
//>
//> predicate should be a function that accepts three arguments and returns a
//> value that is coercible to the Boolean value **true** or
//> **false**. `findIndex` calls predicate once for each element present in the
//> array, in ascending order, until it finds one where predicate returns
//> **true**. If such an element is found, `findIndex` immediately returns the
//> index of that element value. Otherwise, `findIndex` returns -1. predicate
//> is called only for elements of the array which actually exist; it is not
//> called for missing elements of the array.
//>
//> If a thisArg parameter is provided, it will be used as the this value for
//> each invocation of predicate. If it is not provided, undefined is used
//> instead.
//>
//> predicate is called with three arguments: the value of the element, the
//> index of the element, and the object being traversed.
//>
//> `findIndex` does not directly mutate the object on which it is called but the
//> object may be mutated by the calls to predicate.
//>
//> The range of elements processed by `findIndex` is set before the first call
//> to callbackfn. Elements that are appended to the array after the call to
//> `findIndex` begins will not be visited by callbackfn. If existing elements of
//> the array are changed, their value as passed to predicate will be the value
//> at the time that `findIndex` visits them; elements that are deleted after the
//> call to `findIndex` begins and before being visited are not visited.
//>
//> When the `findIndex` method is called with one or two arguments, the
//> following steps are taken:
//>
function ArrayFindIndex(predicate/*, thisArg*/) {
//> 1. Let O be the result of calling ToObject passing the this value as the
//>    argument.
//> 1. ReturnIfAbrupt(O).
    var O = ToObject(this);

//> 1. Let lenValue be the result of Get(O, "length").
//> 1. Let len be ToLength(lenValue).
//> 1. ReturnIfAbrupt(len).
    var len = ToInteger(O.length);

//> 1. If IsCallable(predicate) is **false**, throw a **TypeError** exception.
    if (arguments.length === 0)
        ThrowError(JSMSG_MISSING_FUN_ARG, 0, 'Array.prototype.find');
    if (!IsCallable(predicate))
        ThrowError(JSMSG_NOT_FUNCTION, DecompileArg(0, predicate));

//> 1. If thisArg was supplied, let T be thisArg; else let T be **undefined**.
    var T = arguments.length > 1 ? arguments[1] : undefined;

//> 1. Let k be 0.
//> 1. Repeat, while k < len
    /* Note: this will hang in some corner-case situations, because of IEEE-754 numbers'
     * imprecision for large values. Example:
     * var obj = { 18014398509481984: true, length: 18014398509481988 };
     * Array.prototype.find.call(obj, () => true);
     */
    for (var k = 0; k < len; k++) {
//>     1. Let Pk be ToString(k).
//>     1. Let kPresent be the result of HasProperty(O, Pk).
//>     1. ReturnIfAbrupt(kPresent).
//>     1. If kPresent is **true**, then
        if (k in O) {
//>         1. Let kValue be the result of Get(O, Pk).
//>         1. ReturnIfAbrupt(kValue).
//>         1. Let testResult be the result of calling the [[Call]] internal
//>            method of predicate with T as <var>thisArgument</var> and a List
//>            containing kValue, k, and O as <var>argumentsList</var>.
//>         1. ReturnIfAbrupt(testResult).
//>         1. If ToBoolean(testResult) is **true**, return k.
            if (callFunction(predicate, T, O[k], k, O))
                return k;
        }
//>     1. Increase k by 1.
    }

//> 1. Return -1.
    return -1;
}
//>
//> The length property of the `findIndex` method is **1**.
//>
//> NOTE The `findIndex` function is intentionally generic; it does not require
//> that its **this** value be an Array object. Therefore it can be transferred
//> to other kinds of objects for use as a method. Whether the `findIndex`
//> function can be applied successfully to an exotic object that is not an
//> Array is implementation-dependent.
//>
