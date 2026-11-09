# Osprey samples

Native Osprey projects (`.osprey`, see [docs/format.md](../../docs/format.md)).

`TA7358A.osprey` is the import of the Eagle pair in `../eagle/`. A test keeps the two in step:
it fails if the importer or the writer would now produce something different. After an
intended change to either, regenerate the sample and review the diff:

```sh
npm run samples
```
