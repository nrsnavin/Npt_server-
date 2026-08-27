import mongoose from 'mongoose';

/**
 * Indexes the database enforces that no model asks for.
 *
 * Mongoose creates what a schema declares and never removes what it does not recognise, so
 * an index left by an earlier schema — or by whatever used the database before this app —
 * stays and is enforced forever.
 *
 * The failure worth naming is invisible from the code: a *unique* index on fields our
 * documents do not have makes every document look like `{ field: null }` to Mongo. The first
 * insert claims that value and every insert afterwards collides. The symptom is that all
 * record creation fails at once; the cause is an index nobody in the codebase has heard of.
 */

/** An index key as a comparable string, so `{a:1,b:1}` matches however it is spelled. */
const signature = (key) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}:${direction}`)
    .join(',');

/**
 * The fields a text index actually covers.
 *
 * Mongo does not report a text index by the fields it was declared on — the key comes back
 * as `{ _fts: 'text', _ftsx: 1 }` whatever went in, and the real fields are in `weights`.
 * Comparing keys therefore makes every text index look like one nobody declared, which
 * would have this tool cheerfully drop the search indexes the app depends on.
 */
const textFields = (index) => Object.keys(index.weights || {}).sort().join(',');

const isTextIndex = (index) => Boolean(index.textIndexVersion) || 'weights' in index;

/** Every index signature a model declares, including the ones Mongoose adds itself. */
export function declaredBy(model) {
  const declared = new Set(['_id:1']);

  for (const [key] of model.schema.indexes()) {
    if (Object.values(key).includes('text')) continue; // handled by declaredTextBy
    declared.add(signature(key));
  }

  // `unique: true` and `index: true` on a path are declared there, not in indexes().
  model.schema.eachPath((path, type) => {
    if (type.options?.unique || type.options?.index) declared.add(signature({ [path]: 1 }));
  });

  return declared;
}

/** The text indexes a model declares, as sorted field lists to compare against `weights`. */
export function declaredTextBy(model) {
  return new Set(
    model.schema
      .indexes()
      .filter(([key]) => Object.values(key).includes('text'))
      .map(([key]) => Object.keys(key).sort().join(','))
  );
}

/**
 * Reports every index the models do not declare.
 *
 * `blocksWrites` marks the dangerous kind: unique, on fields absent from the schema — the
 * one that stops all creation rather than merely costing a little write time.
 */
export async function findUnexpectedIndexes(models = mongoose.models) {
  const findings = [];

  for (const name of Object.keys(models)) {
    const model = models[name];
    const declared = declaredBy(model);
    const declaredText = declaredTextBy(model);

    let existing;
    try {
      existing = await model.collection.indexes();
    } catch {
      // No collection yet, so nothing is being enforced.
      continue;
    }

    const schemaPaths = Object.keys(model.schema.paths);

    for (const index of existing) {
      if (index.name === '_id_') continue;

      if (isTextIndex(index)) {
        if (declaredText.has(textFields(index))) continue;
        // An undeclared text index is still worth reporting, named by what it covers.
        findings.push({
          collection: model.collection.collectionName,
          name: index.name,
          fields: Object.keys(index.weights || {}),
          unique: Boolean(index.unique),
          absentFields: [],
          // A text index cannot be unique on absent fields, so it never blocks writes.
          blocksWrites: false,
        });
        continue;
      }

      if (declared.has(signature(index.key))) continue;

      const fields = Object.keys(index.key);
      const absent = fields.filter((field) => !schemaPaths.includes(field));

      findings.push({
        collection: model.collection.collectionName,
        name: index.name,
        fields,
        unique: Boolean(index.unique),
        absentFields: absent,
        blocksWrites: Boolean(index.unique) && absent.length > 0,
      });
    }
  }

  return findings;
}

/** Drops the given findings, returning what was actually removed. */
export async function dropIndexes(findings, models = mongoose.models) {
  const dropped = [];

  for (const finding of findings) {
    const model = Object.values(models).find(
      (candidate) => candidate.collection.collectionName === finding.collection
    );
    if (!model) continue;

    await model.collection.dropIndex(finding.name);
    dropped.push(finding);
  }

  return dropped;
}
