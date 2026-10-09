# No import cycle between two files

When the file you import already imports you back, move what both need into a third file.

Two files that import each other can only be understood, tested and moved together.
The cycle is invisible in either file alone, which is why it tends to be noticed late.

## Instead

Put the shared piece into a file both can import, or pass it in from the caller.

## When it is fine

A `part` and its library are one unit in Dart and do not count.
