# metro-map-mod

A Claude Code mod: when Claude runs `nextflow run`, a pane draws the pipeline as a live
metro map.

```
FETCHNGS · stupefied_becquerel
         ●━━━━━━━━━━━━━━●━━━━━━┳╌╌╌╌╌╌╌◌╌╌╌╌╌╌┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━●
   SRA_IDS_TO_    SRA_RUNINFO_ ┃  ASPERA_CLI  ┃                             ╎   MULTIQC_
     RUNINFO         TO_FTP    ┃              ┃                             ╎ MAPPIN…ONFIG
                               ┣╌╌╌╌╌╌╌◌╌╌╌╌╌╌┫                             ╎
                               ┃  SRA_FASTQ_  ┃                             ╎
                               ┃     FTP      ┃                             ╎
                               ┣━━━━━━━●━━━━━━┫                             ╎
                               ╎   FASTQDL    ╎                             ╎
                               ╌╌╌╌╌╌╌╌◌╌╌╌╌╌╌╌╌╌╌╌╌╌╌◌╌╌╌╌╌╌╌╌╌╌╌╌╌╌◌╌╌╌╌╌╌╌
                                   CUSTOM_       SRATOOLS_      SRATOOLS_
                                 SRATOO…TINGS     PREFETCH     FASTERQDUMP
                                 ╰ FASTQ_DOWNLOAD_PREFETCH_FASTERQDUMP_SR─╯
```

`○` pending · `◉` running · `●` done · `✖` failed · `◌` never ran

## Install

```bash
claude plugin marketplace add camlloyd/metro-map-mod
claude plugin install metro-map-mod@metro-map-mod
```

Needs Nextflow and `python3`. `/metro-map` opens the pane.

Try it: ask Claude to run

```bash
echo DRR028935 > ids.csv
nextflow run nf-core/fetchngs -profile test,docker --input ids.csv --download_method fastq-dl --outdir results
```

## How it works

- Adds `-c <weblog config>` to each `nextflow run` Claude starts (`-with-weblog` when the
  command uses `-C`); a local listener turns the events into station states.
- Re-runs the command once with `-preview -with-dag` for the graph, in
  `.nextflow/metro-map/` with its own `NXF_CACHE_DIR`, so your history is untouched.
- On `-resume`, cached tasks come from `.nextflow.log`.
- When the run ends, a toast says how it went: `fetchngs done in 2m 3s · 6 succeeded`, or
  `fetchngs failed after 40s at SRA_FASTQ_FTP`.

## Develop

```bash
claude --plugin-dir .
claude plugin test .
```

## License

[MIT](LICENSE)
