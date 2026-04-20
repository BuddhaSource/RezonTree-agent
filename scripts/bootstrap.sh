#!/bin/bash
# Bootstrap RezonTree agents: create agents in DB, issue credentials, fund wallets.
# Usage: ./scripts/bootstrap.sh
set -euo pipefail

API_URL="${REZONTREE_API_URL:-http://localhost:8080}"
DB_URL="${DATABASE_URL:-postgres://rezontree:rezontree@localhost:5432/rezontree?sslmode=disable}"

USER_EMAIL="agentkit@rezontree.local"
USER_PASSWORD="agentkit-dev-2026"
USER_NAME="AgentKit Operator"

AGENTS=("questioner-01" "questioner-02" "solver-02" "solver-03" "solver-04" "solver-05")
AGENT_NAMES=("Questioner 01" "Questioner 02" "Solver 02" "Solver 03" "Solver 04" "Solver 05")
FUND_AMOUNT="100.00"

echo "=== RezonTree Agent Bootstrap ==="
echo ""

# Step 1: Register or login user
echo "── Step 1: Authenticating user ──"
REGISTER_RESP=$(curl -sf "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\",\"name\":\"$USER_NAME\"}" 2>/dev/null || true)

if [ -z "$REGISTER_RESP" ] || echo "$REGISTER_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' in d else 1)" 2>/dev/null; then
  echo "  User exists, logging in..."
  LOGIN_RESP=$(curl -sf "$API_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\"}")
  TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
  USER_ID=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
else
  echo "  User registered."
  TOKEN=$(echo "$REGISTER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
  USER_ID=$(echo "$REGISTER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
fi
echo "  User ID: $USER_ID"
echo ""

# Step 2: Create agents in database
echo "── Step 2: Creating agents in database ──"
for i in "${!AGENTS[@]}"; do
  AGENT_ID="${AGENTS[$i]}"
  AGENT_NAME="${AGENT_NAMES[$i]}"

  psql "$DB_URL" -q -c "
    INSERT INTO agents (id, user_id, created_by, name, status)
    VALUES ('$AGENT_ID', '$USER_ID', '$USER_ID', '$AGENT_NAME', 'active')
    ON CONFLICT (id) DO NOTHING;
  " 2>/dev/null
  echo "  Created agent: $AGENT_ID ($AGENT_NAME)"
done
echo ""

# Step 3: Issue credentials and update .env
echo "── Step 3: Issuing agent credentials ──"
ENV_FILE="$(dirname "$0")/../.env"
ENV_UPDATES=""

for AGENT_ID in "${AGENTS[@]}"; do
  CRED_RESP=$(curl -sf "$API_URL/v1/agents/$AGENT_ID/credentials" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$AGENT_ID-bootstrap\"}")

  RAW_TOKEN=$(echo "$CRED_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

  # Convert agent-id to ENV_KEY format: questioner-01 -> QUESTIONER_01
  ENV_KEY=$(echo "$AGENT_ID" | tr '[:lower:]-' '[:upper:]_')
  ENV_UPDATES="$ENV_UPDATES\nREZONTREE_${ENV_KEY}_SECRET=$RAW_TOKEN"

  echo "  Issued token for $AGENT_ID: ${RAW_TOKEN:0:20}..."
done
echo ""

# Step 4: Fund agent wallets
echo "── Step 4: Funding agent wallets ──"
for AGENT_ID in "${AGENTS[@]}"; do
  # Authenticate as agent first to get agent JWT
  ENV_KEY=$(echo "$AGENT_ID" | tr '[:lower:]-' '[:upper:]_')
  AGENT_SECRET=$(echo -e "$ENV_UPDATES" | grep "REZONTREE_${ENV_KEY}_SECRET=" | tail -1 | cut -d= -f2)

  AGENT_TOKEN_RESP=$(curl -sf "$API_URL/auth/token" \
    -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"client_credentials\",\"client_secret\":\"$AGENT_SECRET\"}")
  AGENT_JWT=$(echo "$AGENT_TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

  # Deposit funds
  curl -sf "$API_URL/v1/wallet/deposit" \
    -H "Authorization: Bearer $AGENT_JWT" \
    -H "Content-Type: application/json" \
    -d "{\"amount\":\"$FUND_AMOUNT\",\"currency\":\"USD\"}" > /dev/null

  echo "  Funded $AGENT_ID: \$$FUND_AMOUNT USD"
done
echo ""

# Step 5: Write updated .env
echo "── Step 5: Updating .env file ──"
# Update each secret in the .env file
echo -e "$ENV_UPDATES" | grep -v '^$' | while IFS='=' read -r KEY VALUE; do
  if grep -q "^$KEY=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^$KEY=.*|$KEY=$VALUE|" "$ENV_FILE"
  else
    echo "$KEY=$VALUE" >> "$ENV_FILE"
  fi
done

echo "  .env updated with new credentials"
echo ""
echo "=== Bootstrap Complete ==="
echo "  ${#AGENTS[@]} agents created, funded with \$$FUND_AMOUNT each"
echo "  Credentials saved to .env"
