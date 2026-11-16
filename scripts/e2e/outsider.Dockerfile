FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends strace openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /consumer
COPY dogsled.tgz ./dogsled.tgz
RUN printf '{"private":true,"type":"module"}\n' > package.json && npm install --no-audit --no-fund --cache /tmp/npm-cache --userconfig=/dev/null --registry=https://registry.npmjs.org ./dogsled.tgz && rm -rf /tmp/npm-cache
RUN npm install --global --prefix /global --no-audit --no-fund --cache /tmp/npm-cache --userconfig=/dev/null --registry=https://registry.npmjs.org /consumer/dogsled.tgz && rm -rf /tmp/npm-cache && test ! -e /global/etc/npmrc
ARG DOGSLED_E2E_BEFORE
ARG DOGSLED_E2E_USER_PG_VERSION
RUN mkdir /consumer-pg && cd /consumer-pg && printf '{"private":true,"type":"module"}\n' > package.json && npm install --no-audit --no-fund --cache /tmp/npm-cache --userconfig=/dev/null --registry=https://registry.npmjs.org --before="$DOGSLED_E2E_BEFORE" --save-exact "pg@$DOGSLED_E2E_USER_PG_VERSION" && npm install --no-audit --no-fund --cache /tmp/npm-cache --userconfig=/dev/null --registry=https://registry.npmjs.org /consumer/dogsled.tgz && rm -rf /tmp/npm-cache
COPY suite /suite
ENV DOGSLED_E2E_CLI=/consumer/node_modules/@bobsled-inc/bobsled-core/bin/cli.mjs
ENV DOGSLED_E2E_OUTSIDER=1
ENV DOGSLED_E2E_USER_PG_VERSION=$DOGSLED_E2E_USER_PG_VERSION
RUN node /suite/scripts/e2e/verify-install.mjs && node /suite/scripts/e2e/outsider-packaging.mjs install && node --test /suite/scripts/e2e/harness.test.mjs
COPY inside-outsider.sh /run-outsider.sh
ENTRYPOINT ["sh", "/run-outsider.sh"]
