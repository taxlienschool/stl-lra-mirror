# stl-lra-mirror

This repository mirrors, once a night, the City of St. Louis's public Land Reutilization Authority (LRA) inventory file (https://static.stlouis-mo.gov/open-data/SLDC/REAL-ESTATE/LRA_INVENTORY_AVAILABLE.csv) and, for the parcels in it, appraised values and parcel outlines from the City's public parcel layer (https://maps6.stlouis-mo.gov/arcgis/rest/services/St_Louis_Parcels/MapServer/0).

## Pennsylvania repository lists (job `pa`)

Some Pennsylvania county sites refuse tls-ai-platform's servers but answer GitHub's. The `pa` job (scripts/pa-mirror.mjs) asks the app which county pages to fetch, makes one request per page and per list file, and posts the file straight to the app (`/api/cron/pa-mirror`, bearer `PA_MIRROR_TOKEN`), which reads it with its own code. Nothing from these lists is committed here: they carry owner names. It also looks up Luzerne County parcel values for the parcels on Luzerne's repository list and posts them to the app the same way. Logs show status lines only.
