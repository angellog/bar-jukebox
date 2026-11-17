#!/usr/bin/env bash
# Move QueuePlay's database from Railway Postgres to the VM's shared Postgres.
# Run ON THE VM, during the cutover window (stop writes first, see deploy/README.md).
#
#   RAILWAY_DATABASE_URL=postgresql://...proxy.rlwy.net:PORT/railway \
#   QUEUEPLAY_DB_PASSWORD=... \
#   deploy/migrate-db.sh
set -euo pipefail
: "${RAILWAY_DATABASE_URL:?set RAILWAY_DATABASE_URL (Railway Postgres → Variables → DATABASE_PUBLIC_URL)}"
: "${QUEUEPLAY_DB_PASSWORD:?set QUEUEPLAY_DB_PASSWORD (the password used in .env DATABASE_URL)}"
PG_CONTAINER="${PG_CONTAINER:-postgres}"
DUMP="queueplay-railway-$(date +%Y%m%d-%H%M).dump"
mkdir -p "$HOME/backups"

echo "1/4 Dumping Railway database → ~/backups/$DUMP"
docker run --rm --network host -e SRC="$RAILWAY_DATABASE_URL" -v "$HOME/backups:/out" postgres:18 \
  sh -c "pg_dump --format=custom --no-owner --no-privileges --file=/out/$DUMP \"\$SRC\""

echo "2/4 Creating role + database 'queueplay' (skipped if they exist)"
docker exec -i "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'queueplay') THEN
    CREATE ROLE queueplay LOGIN PASSWORD '${QUEUEPLAY_DB_PASSWORD}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE queueplay OWNER queueplay'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'queueplay')\gexec
SQL

echo "3/4 Restoring into the VM database"
docker cp "$HOME/backups/$DUMP" "$PG_CONTAINER:/tmp/$DUMP"
docker exec "$PG_CONTAINER" pg_restore --clean --if-exists --no-owner --role=queueplay \
  -U postgres -d queueplay "/tmp/$DUMP"
docker exec "$PG_CONTAINER" rm "/tmp/$DUMP"

echo "4/4 Row counts (compare with Railway):"
docker exec "$PG_CONTAINER" psql -U postgres -d queueplay -c \
  "SELECT 'venues' t, count(*) FROM venues UNION ALL SELECT 'payments', count(*) FROM payments UNION ALL SELECT 'queue', count(*) FROM queue;"
echo "Done. Dump kept at ~/backups/$DUMP"
