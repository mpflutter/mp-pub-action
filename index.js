const core = require("@actions/core");
const github = require("@actions/github");
const YAML = require("yaml");
const { execSync } = require("child_process");
const COS = require("cos-nodejs-sdk-v5");
const {
  createReadStream,
  readFileSync,
  createWriteStream,
  existsSync,
  writeFileSync,
} = require("fs");

const env = {
  secret_id: core.getInput("secret_id"),
  secret_key: core.getInput("secret_key"),
  cos_bucket: core.getInput("cos_bucket"),
  cos_region: core.getInput("cos_region"),
  package_name: core.getInput("package_name"),
  package_path: core.getInput("package_path"),
};

const cosInstance = new COS({
  SecretId: env.secret_id,
  SecretKey: env.secret_key,
  UseAccelerate: true,
});
let currentVersion = github.context.ref.replace("refs/tags/", "");
let originYaml = YAML.parse(
  readFileSync(`${env.package_path}/pubspec.yaml`, {
    encoding: "utf-8",
  })
);

class DartPackageDeployer {
  constructor(name) {
    this.name = name;
  }

  async deploy() {
    this.rewritePubspec();
    this.makeArchive();
    const archiveUrl = await this.uploadArchive();
    const pubspec = this.makePubspec(archiveUrl);
    await this.updatePackage(pubspec);
  }

  rewritePubspec() {
    originYaml.version = currentVersion;
    writeFileSync(
      `${env.package_path}/pubspec.yaml`,
      YAML.stringify(originYaml)
    );
  }

  makeArchive() {
    execSync(`tar -czf ${currentVersion}.tar.gz *`, {
      cwd: env.package_path,
    });
    execSync(`mv ${currentVersion}.tar.gz /tmp/${currentVersion}.tar.gz`, {
      cwd: env.package_path,
    });
  }

  uploadArchive() {
    return new Promise((res, rej) => {
      cosInstance.putObject(
        {
          Bucket: env.cos_bucket,
          Region: env.cos_region,
          Key: `/${this.name}/versions/${currentVersion}.tar.gz`,
          StorageClass: "STANDARD",
          Body: createReadStream(`/tmp/${currentVersion}.tar.gz`),
        },
        (err, data) => {
          if (!err) {
            res(
              `https://dist.mpflutter.com/${this.name}/versions/${currentVersion}.tar.gz`
            );
          } else {
            res(rej);
          }
        }
      );
    });
  }

  makePubspec(archiveUrl) {
    return {
      version: currentVersion,
      pubspec: {
        version: currentVersion,
        name: this.name,
        author: originYaml.author || "MPFlutter",
        description: originYaml.description || "/",
        homepage: originYaml.homepage || "/",
        environment: {
          sdk: originYaml.environment?.sdk
            ? originYaml.environment.sdk
            : undefined,
          flutter: originYaml.environment?.flutter
            ? originYaml.environment.flutter
            : undefined,
        },
        dependencies: originYaml.dependencies || {},
        dev_dependencies: originYaml.dev_dependencies || {},
      },
      archive_url: archiveUrl,
      published: new Date().toISOString(),
    };
  }

  updatePackage(pubspec) {
    return new Promise((res, rej) => {
      cosInstance.getObject(
        {
          Bucket: env.cos_bucket,
          Region: env.cos_region,
          Key: `/${this.name}/package.json`,
          Output: createWriteStream(`/tmp/${this.name}.package.json`),
        },
        () => {
          let contents = "{}";
          if (existsSync(`/tmp/${this.name}.package.json`)) {
            contents = readFileSync(`/tmp/${this.name}.package.json`, {
              encoding: "utf-8",
            });
          }
          let pkgJSON = (() => {
            try {
              return JSON.parse(contents);
            } catch (error) {
              return {};
            }
          })();
          pkgJSON["name"] = this.name;
          if (currentVersion !== "0.0.1-master") {
            pkgJSON["latest"] = pubspec;
          }
          if (!pkgJSON["versions"]) {
            pkgJSON["versions"] = [];
          }
          let replaced = false;
          for (let index = 0; index < pkgJSON["versions"].length; index++) {
            const element = pkgJSON["versions"][index];
            if (element.version === currentVersion) {
              pkgJSON["versions"][index] = pubspec;
              replaced = true;
            }
          }
          if (!replaced) {
            pkgJSON["versions"].push(pubspec);
          }
          writeFileSync(
            `/tmp/${this.name}.package.json`,
            JSON.stringify(pkgJSON)
          );
          cosInstance.putObject(
            {
              Bucket: env.cos_bucket,
              Region: env.cos_region,
              Key: `/${this.name}/package.json`,
              StorageClass: "STANDARD",
              Body: createReadStream(`/tmp/${this.name}.package.json`),
            },
            (err, data) => {
              if (!err) {
                res(null);
              } else {
                res(rej);
              }
            }
          );
        }
      );
    });
  }
}

new DartPackageDeployer(env.package_name).deploy();
