# Avoid the `late` Keyword

Avoid the late keyword, because it turns a compile time check into a runtime LateInitializationError; initialize in the constructor or use a nullable type.

Using `late` can lead to runtime errors if a variable is accessed before being initialized.
Instead, prefer initializing fields in constructors or using nullable types where applicable.

## Exception: self-referential local construction

A `late final` local is acceptable when it is assigned immediately to a newly constructed object and a callback in that initializer must capture the object itself. Keep the declaration and assignment adjacent so the value cannot be read before initialization.

```dart
late final ToastItem item;
item = ToastItem(
  onDismissed: () => overlay.remove(item),
);
```

## Exception: lazy Flutter State fields that require this

A `late final` field with an inline initializer is acceptable in a Flutter `State` class when the initializer requires `this`. The initializer is lazy, so it runs only after the state object exists.

```dart
class _MyWidgetState extends State<MyWidget>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
  );
}
```

## Exception: State Beacon controller fields created through `B`

A `late final` field is acceptable in a class that mixes in `BeaconController`
or `BeaconControllerMixin` when its inline initializer creates the beacon
through the controller's instance-owned `B` group. State Beacon requires the
lazy initializer so it can access that group, which also owns disposal of the
created beacon.

```dart
class ProjectManager with BeaconController {
  late final WritableBeacon<Map<String, List<String>>> actionBarOrders =
      B.writable(const {});
}
```

## Exception: Flutter State lifecycle

`late final` is acceptable in `State` classes when the field is initialized in `initState()` and disposed in `dispose()`. This is the standard Flutter lifecycle pattern, and Flutter guarantees `initState()` runs before `build()`, so there is no risk of accessing the field before initialization.

```dart
// OK: standard State lifecycle pattern
class _MyWidgetState extends State<MyWidget> {
  late final SomeController _controller;

  @override
  void initState() {
    super.initState();
    _controller = SomeController();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}
```
