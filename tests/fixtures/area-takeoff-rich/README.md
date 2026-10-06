# Swiss Dwellings with retained element types

Same source floors, license and limitations as [the flattened diagnostic](../area-takeoff/README.md).
This is an additional representation of those same 36 rooms, **not another 36
independent examples** and not original construction PDFs.

The source CSV's non-area entity types are mapped to synthetic CAD layer names:
wall separators -> A_WALL; doors -> A_DOOR; features -> A_FIXTURE_*; remaining
subtypes -> A_*. No truth-room polygon edges are used as detector input.
Fixture footprints are included to match the publisher's room-polygon scope.
Labels remain synthetic. The renderer is not an actual PDF exporter.

Reproduce from the same local CSV subset:

```sh
python3 scripts/import-swiss-area-sample.py /path/to/geometries.csv tests/fixtures/area-takeoff-rich --preserve-entity-types
node scripts/benchmark-area-takeoff.js tests/fixtures/area-takeoff-rich
```

Use both versions to distinguish information-loss failures from classification
failures. Neither representation qualifies as an independent PDF holdout.
