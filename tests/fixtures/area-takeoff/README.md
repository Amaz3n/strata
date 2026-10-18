# Swiss Dwellings diagnostic subset

Source: https://zenodo.org/records/7070952 (2022 publication).
Authors: Matthias Standfest et al., Archilyse AG.
License: Creative Commons Attribution 4.0 International (CC BY 4.0):
https://creativecommons.org/licenses/by/4.0/
The record's API metadata reports `license.id = cc-by-4.0`.

Derived from the first 1,048,576 bytes of the published `geometries.csv`, downloaded
September 26, 2026. Three floor subsets, chosen across distinct sites. Partial CSV
records are discarded. Input completeness beyond the downloaded subset is not
certified. Do not represent these as complete original construction sheets.

Modifications: retain selected floors; parse WKT; translate, normalize and flip Y;
convert separators, openings and features into drawn polygon edges; remove
consecutive identical normalized vertices without changing geometry; position text
labels synthetically; retain source room polygons as independent evaluation truth.
No room-truth polygon edges are included in detector inputs. SHAFT, BALCONY and
STAIRS areas are excluded from interior floor-finish truth. No source tools or
model weights have been copied into the application.

Reproduce using `scripts/import-swiss-area-sample.py`. JSON files are compact to
keep the repository small. All inspected samples are development diagnostics;
the original-PDF holdout set remains empty and the release gate must fail.
