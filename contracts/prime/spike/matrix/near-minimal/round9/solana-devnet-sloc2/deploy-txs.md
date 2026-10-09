# Deploy and final transactions (devnet, 2026-10-09)

| Program | Program id | Program data | Deploy tx (slot) | Final tx (slot) |
|---|---|---|---|---|
| prime-session A | 6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba | 2o1PtHRJguYDbihKyutSRTyGXkgMo8ZRPD7dGgKdhRaC | tMwr9cvddu6qLMyXDALLyEmGLHBmPMeEtHQLJw7sJFKCEEo1NM1HCgP9s5GKkrpBj2GW39am93XLQnSLUYfbw1a (509142527) | 4G22erQAK37eMssFnPyXfgwXYNrEsJJ3PgWZyguvsCvafak4Bh2562t5CRNKHTQXFQP7X8UfPB5xAF7cnxG7VbJ1 (509142809) |
| prime-session B | GLabPwsshHoaXMrHM6nHsHEkf51MFkKP86WCdRpXg3SD | 6CEGGuVY6vEaoCGczVyDSYhqPjd9uQrrY3tAAzBXndHd | 2LkKLseBnQAVgifWXZVMiEYbAocrs56hqQoneokb4o3DRDz1NFvU7owdJqy3asa2aDQ1ta7E37MQYug1QHnJU7nG (509142601) | 539WAf1c43uGLCfkPZLyK7VpCQBYTtptTq8Bszj6RBRmV7a8Jcyf4B1sjDV3WWZPFSRnzHb9aP9Dr6rviTEcF4mY (509142814) |
| custody-gate | 6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz | BFMMi5dhPNXpF1PwBzGHCK4u46VUikmsxoEBqUdXsLbu | 4bVXEsmJuWJDBWs3S35iy8LbVQddC6g3zth9dQPyPj2pw4H3AaCsSCDEQp5AJf7JBfz1q7if8ojAGkc2n4KbFvyG (509142706) | 2GGEZ3LW5JoeMUVBFdSWFAPSVrdPLKb1AQmrT9oAFPd2DxGhkANxyUwayKYFCA92n397hpChHHg6XuvNreF6aHDM (509142819) |

Buffers (write-buffer, then deploy from the buffer): session A BGrX4QLM…, session B 3BUPWcLT…, gate 5d8or2ZK…; `solana program show --buffers` lists none afterwards.
Payer before the deploys: 10.22962552 SOL; after the three deploys and their finals: 9.43666668 SOL.

Update (no-op program for check F4, the stand-in for another program, deployed from the same loader flow and locked): program id AARnE8m37ewaTZq4ksPZhGJAsizXQD37JHiGf4mP3R6v, program data 3gVWn61KXybTfZkq1wQYUuPq81rGuWPijUeqxPjmyyZ9, 4,520 bytes, deploy tx 3eVVo1xxSdSko5ZuGjZhnN6LZUtKB79qo1nCeqfb5Kb8PvdhN3q655vmqHC4rLTwcdV3hhqqRjCj9rEXziWfkhVM (slot 509146173), final tx 4Zu11wkV7HG84D13bAXsVfiffV2D3UsUvcr2irAUcZMKbRsqqBNeM7xYAh6CYhFi6yxLjgiwTzcpycQYboxDQEzK (slot 509146178). Buffer CaRCd31v...
Final slots of the three main programs: session A 509142809, session B 509142814, gate 509142819.
