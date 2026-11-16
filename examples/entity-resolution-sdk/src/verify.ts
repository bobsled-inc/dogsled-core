import { createBobsledClient } from '../generated/bobsled-sdk/index.js';
import { createExampleExecutor } from './executor.js';
import * as runner from '../runner.js';

const dogsled = createBobsledClient(createExampleExecutor(runner));

try {
  const acme = await dogsled.entity.Customer.findBy({ domain: 'acme.com' })
    .withRelationship('document_mentions_customer')
    .first();

  if (!acme) {
    throw new Error('Expected SDK query to return the seeded Acme Corp profile.');
  }
  if (acme.profile.entity_id !== 'cust_acme') {
    throw new Error(`Expected cust_acme, received ${String(acme.profile.entity_id)}.`);
  }
} finally {
  await runner.close();
}
