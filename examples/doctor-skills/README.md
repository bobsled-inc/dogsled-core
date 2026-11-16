# Doctor and Project Skills

This committed project contains a fictional guide, one Skill and a valid empty
pipeline configuration. No AI provider call or account is needed.

1. With Dogsled installed, copy the example from the checkout root:

   ```bash
   cp -R examples/doctor-skills /tmp/bobsled-doctor-skills
   cd /tmp/bobsled-doctor-skills
   dogsled skill configure
   dogsled skill validate
   dogsled skill list
   dogsled doctor --json
   ```

   Expect `shop-overview` in the list, valid Skills and `valid: true` from doctor.

2. Introduce a structurally valid model with an unresolved source reference:

   ```bash
   mkdir -p models
   cp broken-model.example.txt models/broken.yml
   dogsled doctor --json
   ```

   Expect a nonzero exit and a structured error naming `missing_source`.

3. Repair the project by removing that model:

   ```bash
   rm models/broken.yml
   dogsled doctor --json
   ```

   Expect `valid: true` again. `pnpm e2e:doctor-skills` runs these same steps in a
   temporary copy and also verifies the public Project index has no errors.
