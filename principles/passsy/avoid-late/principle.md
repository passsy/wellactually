# Avoid the late keyword

A late field moves a compile time guarantee to a runtime crash; initialize in the constructor or make the field nullable.

`late` tells the compiler to stop checking that a field is initialized before it is read.
The check still happens, at runtime, as a `LateInitializationError` in production.

## Instead

- Initialize the field in the constructor initializer list.
- Make the field nullable and handle `null` where it is read.
  The compiler then shows every place that has to deal with the missing value.
- Pass the value in as a constructor parameter.

```dart
// Bad
class Session {
  late User user;
}

// Good
class Session {
  Session(this.user);

  final User user;
}
```

## When late is fine

A `late final` field with an initializer that needs `this` is lazy initialization, not deferred assignment.
`late final controller = AnimationController(vsync: this);` cannot be written any other way and cannot throw.
