import * as path from "path";
import * as shell from "shelljs";
import * as os from "os";
import * as semver from "semver";
import * as xcode from "xcode";
import * as constants from "../constants";
import * as helpers from "../common/helpers";
import * as projectServiceBaseLib from "./platform-project-service-base";
import Future = require("fibers/future");
import { PlistSession } from "plist-merge-patch";
import {EOL} from "os";
import * as temp from "temp";
import * as plist from "plist";

export class IOSProjectService extends projectServiceBaseLib.PlatformProjectServiceBase implements IPlatformProjectService {
	private static XCODE_PROJECT_EXT_NAME = ".xcodeproj";
	private static XCODE_SCHEME_EXT_NAME = ".xcscheme";
	private static XCODEBUILD_MIN_VERSION = "6.0";
	private static IOS_PROJECT_NAME_PLACEHOLDER = "__PROJECT_NAME__";
	private static IOS_PLATFORM_NAME = "ios";
	private static PODFILE_POST_INSTALL_SECTION_NAME = "post_install";

	private get $npmInstallationManager(): INpmInstallationManager {
		return this.$injector.resolve("npmInstallationManager");
	}

	constructor($projectData: IProjectData,
		$fs: IFileSystem,
		private $childProcess: IChildProcess,
		private $cocoapodsService: ICocoaPodsService,
		private $errors: IErrors,
		private $logger: ILogger,
		private $iOSEmulatorServices: Mobile.IEmulatorPlatformServices,
		private $iOSSimResolver: Mobile.IiOSSimResolver,
		private $options: IOptions,
		private $injector: IInjector,
		$projectDataService: IProjectDataService,
		private $prompter: IPrompter,
		private $config: IConfiguration,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $devicesService: Mobile.IDevicesService,
		private $mobileHelper: Mobile.IMobileHelper,
		private $pluginVariablesService: IPluginVariablesService,
		private $xcprojService: IXcprojService) {
		super($fs, $projectData, $projectDataService);
	}

	public get platformData(): IPlatformData {
		let projectRoot = path.join(this.$projectData.platformsDir, "ios");

		return {
			frameworkPackageName: "tns-ios",
			normalizedPlatformName: "iOS",
			appDestinationDirectoryPath: path.join(projectRoot, this.$projectData.projectName),
			platformProjectService: this,
			emulatorServices: this.$iOSEmulatorServices,
			projectRoot: projectRoot,
			deviceBuildOutputPath: path.join(projectRoot, "build", "device"),
			emulatorBuildOutputPath: path.join(projectRoot, "build", "emulator"),
			validPackageNamesForDevice: [
				this.$projectData.projectName + ".ipa"
			],
			validPackageNamesForEmulator: [
				this.$projectData.projectName + ".app"
			],
			frameworkFilesExtensions: [".a", ".framework", ".bin"],
			frameworkDirectoriesExtensions: [".framework"],
			frameworkDirectoriesNames: ["Metadata", "metadataGenerator", "NativeScript", "internal"],
			targetedOS: ['darwin'],
			configurationFileName: "Info.plist",
			configurationFilePath: path.join(projectRoot, this.$projectData.projectName, this.$projectData.projectName + "-Info.plist"),
			relativeToFrameworkConfigurationFilePath: path.join("__PROJECT_NAME__", "__PROJECT_NAME__-Info.plist"),
			fastLivesyncFileExtensions: [".tiff", ".tif", ".jpg", "jpeg", "gif", ".png", ".bmp", ".BMPf", ".ico", ".cur", ".xbm"] // https://developer.apple.com/library/ios/documentation/UIKit/Reference/UIImage_Class/
		};
	}

	public getAppResourcesDestinationDirectoryPath(): IFuture<string> {
		return (() => {
			let frameworkVersion = this.getFrameworkVersion(this.platformData.frameworkPackageName).wait();

			if (semver.lt(frameworkVersion, "1.3.0")) {
				return path.join(this.platformData.projectRoot, this.$projectData.projectName, "Resources", "icons");
			}

			return path.join(this.platformData.projectRoot, this.$projectData.projectName, "Resources");
		}).future<string>()();
	}

	public validate(): IFuture<void> {
		return (() => {
			try {
				this.$childProcess.exec("which xcodebuild").wait();
			} catch (error) {
				this.$errors.fail("Xcode is not installed. Make sure you have Xcode installed and added to your PATH");
			}

			let xcodeBuildVersion = this.getXcodeVersion();
			if (helpers.versionCompare(xcodeBuildVersion, IOSProjectService.XCODEBUILD_MIN_VERSION) < 0) {
				this.$errors.fail("NativeScript can only run in Xcode version %s or greater", IOSProjectService.XCODEBUILD_MIN_VERSION);
			}

		}).future<void>()();
	}

	public createProject(frameworkDir: string, frameworkVersion: string, pathToTemplate?: string): IFuture<void> {
		return (() => {
			this.$fs.ensureDirectoryExists(path.join(this.platformData.projectRoot, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER)).wait();
			if (pathToTemplate) {
				// Copy everything except the template from the runtime
				this.$fs.readDirectory(frameworkDir).wait()
					.filter(dirName => dirName.indexOf(IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER) === -1)
					.forEach(dirName => shell.cp("-R", path.join(frameworkDir, dirName), this.platformData.projectRoot));
				shell.cp("-rf", path.join(pathToTemplate, "*"), this.platformData.projectRoot);
			} else if (this.$options.symlink) {
				let xcodeProjectName = `${IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER}.xcodeproj`;

				shell.cp("-R", path.join(frameworkDir, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER, "*"), path.join(this.platformData.projectRoot, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER));
				shell.cp("-R", path.join(frameworkDir, xcodeProjectName), this.platformData.projectRoot);

				let directoryContent = this.$fs.readDirectory(frameworkDir).wait();
				let frameworkFiles = _.difference(directoryContent, [IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER, xcodeProjectName]);
				_.each(frameworkFiles, (file: string) => {
					this.$fs.symlink(path.join(frameworkDir, file), path.join(this.platformData.projectRoot, file)).wait();
				});
			} else {
				shell.cp("-R", path.join(frameworkDir, "*"), this.platformData.projectRoot);
			}
		}).future<void>()();
	}

	public interpolateData(): IFuture<void> {
		return (() => {
			let infoPlistFilePath = path.join(this.platformData.projectRoot, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER, `${IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER}-Info.plist`);
			this.interpolateConfigurationFile(infoPlistFilePath).wait();

			let projectRootFilePath = path.join(this.platformData.projectRoot, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER);
			// Starting with NativeScript for iOS 1.6.0, the project Info.plist file resides not in the platform project,
			// but in the hello-world app template as a platform specific resource.
			if (this.$fs.exists(path.join(projectRootFilePath, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER + "-Info.plist")).wait()) {
				this.replaceFileName("-Info.plist", projectRootFilePath).wait();
			}
			this.replaceFileName("-Prefix.pch", projectRootFilePath).wait();

			let xcschemeDirPath = path.join(this.platformData.projectRoot, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER + IOSProjectService.XCODE_PROJECT_EXT_NAME, "xcshareddata/xcschemes");
			let xcschemeFilePath = path.join(xcschemeDirPath, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER + IOSProjectService.XCODE_SCHEME_EXT_NAME);

			if (this.$fs.exists(xcschemeFilePath).wait()) {
				this.$logger.debug("Found shared scheme at xcschemeFilePath, renaming to match project name.");
				this.$logger.debug("Checkpoint 0");
				this.replaceFileContent(xcschemeFilePath).wait();
				this.$logger.debug("Checkpoint 1");
				this.replaceFileName(IOSProjectService.XCODE_SCHEME_EXT_NAME, xcschemeDirPath).wait();
				this.$logger.debug("Checkpoint 2");
			} else {
				this.$logger.debug("Copying xcscheme from template not found at " + xcschemeFilePath);
			}

			this.replaceFileName(IOSProjectService.XCODE_PROJECT_EXT_NAME, this.platformData.projectRoot).wait();

			let pbxprojFilePath = this.pbxProjPath;
			this.replaceFileContent(pbxprojFilePath).wait();

		}).future<void>()();
	}

	public interpolateConfigurationFile(configurationFilePath?: string): IFuture<void> {
		return (() => {
			shell.sed('-i', "__CFBUNDLEIDENTIFIER__", this.$projectData.projectId, configurationFilePath || this.platformData.configurationFilePath);
		}).future<void>()();
	}

	public afterCreateProject(projectRoot: string): IFuture<void> {
		return (() => {
			this.$fs.rename(path.join(projectRoot, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER),
				path.join(projectRoot, this.$projectData.projectName)).wait();
		}).future<void>()();
	}

	/**
	 * Archive the Xcode project to .xcarchive.
	 * Returns the path to the .xcarchive.
	 */
	public archive(options?: { archivePath?: string }): IFuture<string> {
		return (() => {
			let projectRoot = this.platformData.projectRoot;
			let archivePath = options && options.archivePath ? path.resolve(options.archivePath) : path.join(projectRoot, "/build/archive/", this.$projectData.projectName + ".xcarchive");
			let args = ["archive", "-archivePath", archivePath]
				.concat(this.xcbuildProjectArgs(projectRoot, "scheme"));
			this.$childProcess.spawnFromEvent("xcodebuild", args, "exit", { cwd: this.$options, stdio: 'inherit' }).wait();
			return archivePath;
		}).future<string>()();
	}

	/**
	 * Exports .xcarchive for AppStore distribution.
	 */
	public exportArchive(options: { archivePath: string, exportDir?: string, teamID?: string }): IFuture<string> {
		return (() => {
			let projectRoot = this.platformData.projectRoot;
			let archivePath = options.archivePath;
			// The xcodebuild exportPath expects directory and writes the <project-name>.ipa at that directory.
			let exportPath = path.resolve(options.exportDir || path.join(projectRoot, "/build/archive"));
			let exportFile = path.join(exportPath, this.$projectData.projectName + ".ipa");

			// These are the options that you can set in the Xcode UI when exporting for AppStore deployment.
			let plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`;
			if (options && options.teamID) {
				plistTemplate += `    <key>teamID</key>
    <string>${options.teamID}</string>
`;
			}
			plistTemplate += `    <key>method</key>
    <string>app-store</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <false/>
</dict>
</plist>`;

			// Save the options...
			temp.track();
			let exportOptionsPlist = temp.path({ prefix: "export-", suffix: ".plist" });
			this.$fs.writeFile(exportOptionsPlist, plistTemplate).wait();

			let args = ["-exportArchive",
				"-archivePath", archivePath,
				"-exportPath", exportPath,
				"-exportOptionsPlist", exportOptionsPlist
			];
			this.$childProcess.spawnFromEvent("xcodebuild", args, "exit", { cwd: this.$options, stdio: 'inherit' }).wait();

			return exportFile;
		}).future<string>()();
	}

	private xcbuildProjectArgs(projectRoot: string, product?: "scheme" | "target"): string[] {
		let xcworkspacePath = path.join(projectRoot, this.$projectData.projectName + ".xcworkspace");
		if (this.$fs.exists(xcworkspacePath).wait()) {
			return ["-workspace", xcworkspacePath, product ? "-" + product : "-scheme", this.$projectData.projectName];
		} else {
			let xcodeprojPath = path.join(projectRoot, this.$projectData.projectName + ".xcodeproj");
			return ["-project", xcodeprojPath, product ? "-" + product : "-target", this.$projectData.projectName];
		}
	}

	public buildProject(projectRoot: string, buildConfig?: IiOSBuildConfig): IFuture<void> {
		return (() => {
			let basicArgs = [
				"-configuration", this.$options.release ? "Release" : "Debug",
				"build",
				'SHARED_PRECOMPS_DIR=' + path.join(projectRoot, 'build', 'sharedpch')
			];

			basicArgs = basicArgs.concat(this.xcbuildProjectArgs(projectRoot));

			// Starting from tns-ios 1.4 the xcconfig file is referenced in the project template
			let frameworkVersion = this.getFrameworkVersion(this.platformData.frameworkPackageName).wait();
			if (semver.lt(frameworkVersion, "1.4.0")) {
				basicArgs.push("-xcconfig", path.join(projectRoot, this.$projectData.projectName, "build.xcconfig"));
			}

			let args: string[] = [];
			let buildForDevice = this.$options.forDevice || (buildConfig && buildConfig.buildForDevice);
			if (buildForDevice) {
				let defaultArchitectures = [
					'ARCHS=armv7 arm64',
					'VALID_ARCHS=armv7 arm64'
				];

				args = basicArgs.concat([
					"-sdk", "iphoneos",
					"CONFIGURATION_BUILD_DIR=" + path.join(projectRoot, "build", "device")
				]);

				args = args.concat((buildConfig && buildConfig.architectures) || defaultArchitectures);

				let xcodeBuildVersion = this.getXcodeVersion();
				if (helpers.versionCompare(xcodeBuildVersion, "8.0")>=0) {
					let teamId = this.getDevelopmentTeam();
					if (teamId) {
						args = args.concat("DEVELOPMENT_TEAM="+teamId);
					}
				}
			} else {
				args = basicArgs.concat([
					"-sdk", "iphonesimulator",
					"ARCHS=i386 x86_64",
					"VALID_ARCHS=i386 x86_64",
					"ONLY_ACTIVE_ARCH=NO",
					"CONFIGURATION_BUILD_DIR=" + path.join(projectRoot, "build", "emulator"),
					"CODE_SIGN_IDENTITY="
				]);
			}

			if (buildConfig && buildConfig.codeSignIdentity) {
				args.push(`CODE_SIGN_IDENTITY=${buildConfig.codeSignIdentity}`);
			}

			if (buildConfig && buildConfig.mobileProvisionIdentifier) {
				args.push(`PROVISIONING_PROFILE=${buildConfig.mobileProvisionIdentifier}`);
			}

			this.$childProcess.spawnFromEvent("xcodebuild", args, "exit", { cwd: this.$options, stdio: 'inherit' }).wait();

			if (buildForDevice) {
				let buildOutputPath = path.join(projectRoot, "build", "device");

				// Produce ipa file
				let xcrunArgs = [
					"-sdk", "iphoneos",
					"PackageApplication",
					"-v", path.join(buildOutputPath, this.$projectData.projectName + ".app"),
					"-o", path.join(buildOutputPath, this.$projectData.projectName + ".ipa")
				];

				this.$childProcess.spawnFromEvent("xcrun", xcrunArgs, "exit", { cwd: this.$options, stdio: 'inherit' }).wait();
			}
		}).future<void>()();
	}

	public buildForDeploy(platform: string, buildConfig?: IBuildConfig): IFuture<void> {
		if (this.$options.release) {
			return this.buildProject(this.platformData.projectRoot, buildConfig);
		}

		let devicesArchitectures = _(this.$devicesService.getDeviceInstances())
			.filter(d => this.$mobileHelper.isiOSPlatform(d.deviceInfo.platform))
			.map(d => d.deviceInfo.activeArchitecture)
			.uniq()
			.value();

		let architectures = [
			`ARCHS=${devicesArchitectures.join(" ")}`,
			`VALID_ARCHS=${devicesArchitectures.join(" ")}`
		];

		if (devicesArchitectures.length > 1) {
			architectures.push('ONLY_ACTIVE_ARCH=NO');
		}

		buildConfig = buildConfig || {};
		buildConfig.architectures = architectures;

		return this.buildProject(this.platformData.projectRoot, buildConfig);
	}

	public isPlatformPrepared(projectRoot: string): IFuture<boolean> {
		return this.$fs.exists(path.join(projectRoot, this.$projectData.projectName, constants.APP_FOLDER_NAME));
	}

	public deploy(deviceIdentifier: string): IFuture<void> {
		return Future.fromResult();
	}

	private getDeploymentTarget(project: xcode.project): string {
		let configurations = project.pbxXCBuildConfigurationSection();

		for (let configName in configurations) {
			if (!Object.prototype.hasOwnProperty.call(configurations, configName)) {
				continue;
			}

			let configuration = configurations[configName];
			if (typeof configuration !== "object") {
				continue;
			}

			let buildSettings = configuration.buildSettings;
			if (buildSettings["IPHONEOS_DEPLOYMENT_TARGET"]) {
				return buildSettings["IPHONEOS_DEPLOYMENT_TARGET"];
			}
		}
	}

	private ensureIos8DeploymentTarget(project: xcode.project) {
		// tns-ios@2.1.0+ has a default deployment target of 8.0 so this is not needed there
		if (this.getDeploymentTarget(project) === "7.0") {
			project.updateBuildProperty("IPHONEOS_DEPLOYMENT_TARGET", "8.0");
			this.$logger.info("The iOS Deployment Target is now 8.0 in order to support Cocoa Touch Frameworks.");
		}
	}

	private addDynamicFramework(frameworkPath: string): IFuture<void> {
		return (() => {
			this.validateFramework(frameworkPath).wait();

			let targetPath = path.join("lib", this.platformData.normalizedPlatformName);
			let fullTargetPath = path.join(this.$projectData.projectDir, targetPath);
			this.$fs.ensureDirectoryExists(fullTargetPath).wait();
			shell.cp("-R", frameworkPath, fullTargetPath);

			let project = this.createPbxProj();
			let frameworkName = path.basename(frameworkPath, path.extname(frameworkPath));
			let frameworkBinaryPath = path.join(frameworkPath, frameworkName);
			let isDynamic = _.includes(this.$childProcess.spawnFromEvent("otool", ["-Vh", frameworkBinaryPath], "close").wait().stdout, " DYLIB ");

			let frameworkAddOptions: xcode.Options = { customFramework: true };

			if (isDynamic) {
				frameworkAddOptions["embed"] = true;
				this.ensureIos8DeploymentTarget(project);
			}

			let frameworkRelativePath = this.getLibSubpathRelativeToProjectPath(path.basename(frameworkPath));
			project.addFramework(frameworkRelativePath, frameworkAddOptions);
			this.savePbxProj(project).wait();
		}).future<void>()();
	}

	private addStaticLibrary(staticLibPath: string): IFuture<void> {
		return (() => {
			this.validateStaticLibrary(staticLibPath).wait();
			// Copy files to lib folder.
			let libraryName = path.basename(staticLibPath, ".a");
			let libDestinationPath = path.join(this.$projectData.projectDir, path.join("lib", this.platformData.normalizedPlatformName));
			let headersSubpath = path.join("include", libraryName);
			this.$fs.ensureDirectoryExists(path.join(libDestinationPath, headersSubpath)).wait();
			shell.cp("-Rf", staticLibPath, libDestinationPath);
			shell.cp("-Rf", path.join(path.dirname(staticLibPath), headersSubpath), path.join(libDestinationPath, "include"));

			// Add static library to project file and setup header search paths
			let project = this.createPbxProj();
			let relativeStaticLibPath = this.getLibSubpathRelativeToProjectPath(path.basename(staticLibPath));
			project.addFramework(relativeStaticLibPath);

			let relativeHeaderSearchPath = path.join(this.getLibSubpathRelativeToProjectPath(headersSubpath));
			project.addToHeaderSearchPaths({ relativePath: relativeHeaderSearchPath });

			this.generateMobulemap(path.join(libDestinationPath, headersSubpath), libraryName);
			this.savePbxProj(project).wait();
		}).future<void>()();
	}

	public canUpdatePlatform(currentVersion: string, newVersion: string): IFuture<boolean> {
		return (() => {
			let currentXcodeProjectFile = this.buildPathToXcodeProjectFile(currentVersion);
			let currentXcodeProjectFileContent = this.$fs.readFile(currentXcodeProjectFile).wait();

			let newXcodeProjectFile = this.buildPathToXcodeProjectFile(newVersion);
			let newXcodeProjectFileContent = this.$fs.readFile(newXcodeProjectFile).wait();

			return currentXcodeProjectFileContent === newXcodeProjectFileContent;

		}).future<boolean>()();
	}

	public updatePlatform(currentVersion: string, newVersion: string, canUpdate: boolean): IFuture<boolean> {
		return (() => {
			if (!canUpdate) {
				let isUpdateConfirmed = this.$prompter.confirm(`We need to override xcodeproj file. The old one will be saved at ${this.$options.profileDir}. Are you sure?`, () => true).wait();
				if (isUpdateConfirmed) {
					// Copy old file to options["profile-dir"]
					let sourceDir = this.xcodeprojPath;
					let destinationDir = path.join(this.$options.profileDir, "xcodeproj");
					this.$fs.deleteDirectory(destinationDir).wait();
					shell.cp("-R", path.join(sourceDir, "*"), destinationDir);
					this.$logger.info(`Backup file ${sourceDir} at location ${destinationDir}`);
					this.$fs.deleteDirectory(sourceDir).wait();

					// Copy xcodeProject file
					let cachedPackagePath = path.join(this.$npmInstallationManager.getCachedPackagePath(this.platformData.frameworkPackageName, newVersion), constants.PROJECT_FRAMEWORK_FOLDER_NAME, `${IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER}.xcodeproj`);
					shell.cp("-R", path.join(cachedPackagePath, "*"), sourceDir);
					this.$logger.info(`Copied from ${cachedPackagePath} at ${this.platformData.projectRoot}.`);

					let pbxprojFilePath = this.pbxProjPath;
					this.replaceFileContent(pbxprojFilePath).wait();
				}

				return isUpdateConfirmed;
			}

			return true;
		}).future<boolean>()();
	}

	/**
	 * Patch **LaunchScreen.xib** so we can be backward compatible for eternity.
	 * The **xcodeproj** template proior v**2.1.0** had blank white screen launch screen.
	 * We extended that by adding **app/AppResources/iOS/LaunchScreen.storyboard**
	 * However for projects created prior **2.1.0** to keep working without the obsolete **LaunchScreen.xib**
	 * we must still provide it on prepare.
	 * Here we check if **UILaunchStoryboardName** is set to **LaunchScreen** in the **platform/ios/<proj>/<proj>-Info.plist**.
	 * If it is, and no **LaunchScreen.storyboard** nor **.xib** is found in the project, we will create one.
	 */
	private provideLaunchScreenIfMissing(): void {
		try {
			this.$logger.trace("Checking if we need to provide compatability LaunchScreen.xib");
			let platformData = this.platformData;
			let projectPath = path.join(platformData.projectRoot, this.$projectData.projectName);
			let projectPlist = this.getInfoPlistPath();
			let plistContent = plist.parse(this.$fs.readText(projectPlist).wait());
			let storyName = plistContent["UILaunchStoryboardName"];
			this.$logger.trace(`Examining ${projectPlist} UILaunchStoryboardName: "${storyName}".`);
			if (storyName !== "LaunchScreen") {
				this.$logger.trace("The project has its UILaunchStoryboardName set to " + storyName + " which is not the pre v2.1.0 default LaunchScreen, probably the project is migrated so we are good to go.");
				return;
			}

			let expectedStoryPath = path.join(projectPath, "Resources", "LaunchScreen.storyboard");
			if (this.$fs.exists(expectedStoryPath).wait()) {
				// Found a LaunchScreen on expected path
				this.$logger.trace("LaunchScreen.storyboard was found. Project is up to date.");
				return;
			}
			this.$logger.trace("LaunchScreen file not found at: " + expectedStoryPath);

			let expectedXibPath = path.join(projectPath, "en.lproj", "LaunchScreen.xib");
			if (this.$fs.exists(expectedXibPath).wait()) {
				this.$logger.trace("Obsolete LaunchScreen.xib was found. It'k OK, we are probably running with iOS runtime from pre v2.1.0.");
				return;
			}
			this.$logger.trace("LaunchScreen file not found at: " + expectedXibPath);

			let isTheLaunchScreenFile = (fileName: string) => fileName === "LaunchScreen.xib" || fileName === "LaunchScreen.storyboard";
			let matches = this.$fs.enumerateFilesInDirectorySync(projectPath, isTheLaunchScreenFile, { enumerateDirectories: false });
			if (matches.length > 0) {
				this.$logger.trace("Found LaunchScreen by slowly traversing all files here: " + matches + "\nConsider moving the LaunchScreen so it could be found at: " + expectedStoryPath);
				return;
			}

			let compatabilityXibPath = path.join(projectPath, "Resources", "LaunchScreen.xib");
			this.$logger.warn(`Failed to find LaunchScreen.storyboard but it was specified in the Info.plist.
Consider updating the resources in app/App_Resources/iOS/.
A good starting point would be to create a new project and diff the changes with your current one.
Also the following repo may be helpful: https://github.com/NativeScript/template-hello-world/tree/master/App_Resources/iOS
We will now place an empty obsolete compatability white screen LauncScreen.xib for you in ${path.relative(this.$projectData.projectDir, compatabilityXibPath)} so your app may appear as it did in pre v2.1.0 versions of the ios runtime.`);

			let content = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.XIB" version="3.0" toolsVersion="6751" systemVersion="14A389" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES">
    <dependencies>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="6736"/>
    </dependencies>
    <objects>
        <placeholder placeholderIdentifier="IBFilesOwner" id="-1" userLabel="File's Owner"/>
        <placeholder placeholderIdentifier="IBFirstResponder" id="-2" customClass="UIResponder"/>
        <view contentMode="scaleToFill" id="iN0-l3-epB">
            <rect key="frame" x="0.0" y="0.0" width="480" height="480"/>
            <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
            <color key="backgroundColor" white="1" alpha="1" colorSpace="custom" customColorSpace="calibratedWhite"/>
            <nil key="simulatedStatusBarMetrics"/>
            <freeformSimulatedSizeMetrics key="simulatedDestinationMetrics"/>
            <point key="canvasLocation" x="548" y="455"/>
        </view>
    </objects>
</document>`;
			try {
				this.$fs.createDirectory(path.dirname(compatabilityXibPath)).wait();
				this.$fs.writeFile(compatabilityXibPath, content).wait();
			} catch(e) {
				this.$logger.warn("We have failed to add compatability LaunchScreen.xib due to: " + e);
			}
		} catch(e) {
			this.$logger.warn("We have failed to check if we need to add a compatability LaunchScreen.xib due to: " + e);
		}
	}

	public prepareProject(): IFuture<void> {
		return (() => {
			let project = this.createPbxProj();

			this.provideLaunchScreenIfMissing();

			let resources = project.pbxGroupByName("Resources");

			if (resources) {
				let references = project.pbxFileReferenceSection();

				let xcodeProjectImages = _.map(<any[]>resources.children, resource => this.replace(references[resource.value].name));
				this.$logger.trace("Images from Xcode project");
				this.$logger.trace(xcodeProjectImages);

				let appResourcesImages = this.$fs.readDirectory(this.getAppResourcesDestinationDirectoryPath().wait()).wait();
				this.$logger.trace("Current images from App_Resources");
				this.$logger.trace(appResourcesImages);

				let imagesToAdd = _.difference(appResourcesImages, xcodeProjectImages);
				this.$logger.trace(`New images to add into xcode project: ${imagesToAdd.join(", ")}`);
				_.each(imagesToAdd, image => project.addResourceFile(path.relative(this.platformData.projectRoot, path.join(this.getAppResourcesDestinationDirectoryPath().wait(), image))));

				let imagesToRemove = _.difference(xcodeProjectImages, appResourcesImages);
				this.$logger.trace(`Images to remove from xcode project: ${imagesToRemove.join(", ")}`);
				_.each(imagesToRemove, image => project.removeResourceFile(path.join(this.getAppResourcesDestinationDirectoryPath().wait(), image)));

				this.savePbxProj(project).wait();
			}
		}).future<void>()();
	}

	public prepareAppResources(appResourcesDirectoryPath: string): IFuture<void> {
		return (() => {
			let platformFolder = path.join(appResourcesDirectoryPath, this.platformData.normalizedPlatformName);
			let filterFile = (filename: string) => this.$fs.deleteFile(path.join(platformFolder, filename)).wait();

			filterFile(this.platformData.configurationFileName);

			this.$fs.deleteDirectory(this.getAppResourcesDestinationDirectoryPath().wait()).wait();
		}).future<void>()();
	}

	public processConfigurationFilesFromAppResources(): IFuture<void> {
		return (() => {
			this.mergeInfoPlists().wait();
			this.mergeProjectXcconfigFiles().wait();
			_(this.getAllInstalledPlugins().wait())
				.map(pluginData => this.$pluginVariablesService.interpolatePluginVariables(pluginData, this.platformData.configurationFilePath).wait())
				.value();
			this.$pluginVariablesService.interpolateAppIdentifier(this.platformData.configurationFilePath).wait();
		}).future<void>()();
	}

	private getInfoPlistPath(): string {
		return this.$options.baseConfig ||
			path.join(
				this.$projectData.projectDir,
				constants.APP_FOLDER_NAME,
				constants.APP_RESOURCES_FOLDER_NAME,
				this.platformData.normalizedPlatformName,
				this.platformData.configurationFileName
			);
	}
	public ensureConfigurationFileInAppResources(): IFuture<void> {
		return Future.fromResult();
	}

	private mergeInfoPlists(): IFuture<void> {
		return (() => {
			let projectDir = this.$projectData.projectDir;
			let infoPlistPath = this.$options.baseConfig || path.join(projectDir, constants.APP_FOLDER_NAME, constants.APP_RESOURCES_FOLDER_NAME, this.platformData.normalizedPlatformName, this.platformData.configurationFileName);
			this.ensureConfigurationFileInAppResources().wait();

			if (!this.$fs.exists(infoPlistPath).wait()) {
				this.$logger.trace("Info.plist: No app/App_Resources/iOS/Info.plist found, falling back to pre-1.6.0 Info.plist behavior.");
				return;
			}

			let session = new PlistSession({ log: (txt: string) => this.$logger.trace("Info.plist: " + txt) });
			let makePatch = (plistPath: string) => {
				if (!this.$fs.exists(plistPath).wait()) {
					return;
				}

				session.patch({
					name: path.relative(projectDir, plistPath),
					read: () => this.$fs.readFile(plistPath).wait().toString()
				});
			};

			let allPlugins = this.getAllInstalledPlugins().wait();
			for (let plugin of allPlugins) {
				let pluginInfoPlistPath = path.join(plugin.pluginPlatformsFolderPath(IOSProjectService.IOS_PLATFORM_NAME), this.platformData.configurationFileName);
				makePatch(pluginInfoPlistPath);
			}

			makePatch(infoPlistPath);

			if (this.$projectData.projectId) {
				session.patch({
					name: "CFBundleIdentifier from package.json nativescript.id",
					read: () =>
						`<?xml version="1.0" encoding="UTF-8"?>
						<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
						<plist version="1.0">
						<dict>
							<key>CFBundleIdentifier</key>
							<string>${ this.$projectData.projectId}</string>
						</dict>
						</plist>`
				});
			}

			let plistContent = session.build();

			this.$logger.trace("Info.plist: Write to: " + this.platformData.configurationFilePath);
			this.$fs.writeFile(this.platformData.configurationFilePath, plistContent).wait();

		}).future<void>()();
	}

	private getAllInstalledPlugins(): IFuture<IPluginData[]> {
		return (<IPluginsService>this.$injector.resolve("pluginsService")).getAllInstalledPlugins();
	}

	private get xcodeprojPath(): string {
		return path.join(this.platformData.projectRoot, this.$projectData.projectName + IOSProjectService.XCODE_PROJECT_EXT_NAME);
	}

	private get projectPodFilePath(): string {
		return path.join(this.platformData.projectRoot, "Podfile");
	}

	private get pluginsDebugXcconfigFilePath(): string {
		return path.join(this.platformData.projectRoot, "plugins-debug.xcconfig");
	}

	private get pluginsReleaseXcconfigFilePath(): string {
		return path.join(this.platformData.projectRoot, "plugins-release.xcconfig");
	}

	private replace(name: string): string {
		if (_.startsWith(name, '"')) {
			name = name.substr(1, name.length - 2);
		}

		return name.replace(/\\\"/g, "\"");
	}

	private getLibSubpathRelativeToProjectPath(subPath: string): string {
		let targetPath = path.join("lib", this.platformData.normalizedPlatformName);
		let frameworkPath = path.relative("platforms/ios", path.join(targetPath, subPath));
		return frameworkPath;
	}

	private get pbxProjPath(): string {
		return path.join(this.xcodeprojPath, "project.pbxproj");
	}

	private createPbxProj(): any {
		let project = new xcode.project(this.pbxProjPath);
		project.parseSync();

		return project;
	}

	private savePbxProj(project: any): IFuture<void> {
		return this.$fs.writeFile(this.pbxProjPath, project.writeSync());
	}

	public preparePluginNativeCode(pluginData: IPluginData, opts?: any): IFuture<void> {
		return (() => {
			let pluginPlatformsFolderPath = pluginData.pluginPlatformsFolderPath(IOSProjectService.IOS_PLATFORM_NAME);

			this.prepareFrameworks(pluginPlatformsFolderPath, pluginData).wait();
			this.prepareStaticLibs(pluginPlatformsFolderPath, pluginData).wait();
			this.prepareCocoapods(pluginPlatformsFolderPath).wait();
		}).future<void>()();
	}

	public removePluginNativeCode(pluginData: IPluginData): IFuture<void> {
		return (() => {
			let pluginPlatformsFolderPath = pluginData.pluginPlatformsFolderPath(IOSProjectService.IOS_PLATFORM_NAME);

			this.removeFrameworks(pluginPlatformsFolderPath, pluginData).wait();
			this.removeStaticLibs(pluginPlatformsFolderPath, pluginData).wait();
			this.removeCocoapods(pluginPlatformsFolderPath).wait();
		}).future<void>()();
	}

	public afterPrepareAllPlugins(): IFuture<void> {
		return (() => {
			if (this.$fs.exists(this.projectPodFilePath).wait()) {
				let projectPodfileContent = this.$fs.readText(this.projectPodFilePath).wait();
				this.$logger.trace("Project Podfile content");
				this.$logger.trace(projectPodfileContent);

				let firstPostInstallIndex = projectPodfileContent.indexOf(IOSProjectService.PODFILE_POST_INSTALL_SECTION_NAME);
				if (firstPostInstallIndex !== -1 && firstPostInstallIndex !== projectPodfileContent.lastIndexOf(IOSProjectService.PODFILE_POST_INSTALL_SECTION_NAME)) {
					this.$logger.warn(`Podfile contains more than one post_install sections. You need to open ${this.projectPodFilePath} file and manually resolve this issue.`);
				}

				let xcuserDataPath = path.join(this.xcodeprojPath, "xcuserdata");
				let sharedDataPath = path.join(this.xcodeprojPath, "xcshareddata");

				if (!this.$fs.exists(xcuserDataPath).wait() && !this.$fs.exists(sharedDataPath).wait()) {
					this.$logger.info("Creating project scheme...");

					this.checkIfXcodeprojIsRequired().wait();

					let createSchemeRubyScript = `ruby -e "require 'xcodeproj'; xcproj = Xcodeproj::Project.open('${this.$projectData.projectName}.xcodeproj'); xcproj.recreate_user_schemes; xcproj.save"`;
					this.$childProcess.exec(createSchemeRubyScript, { cwd: this.platformData.projectRoot }).wait();
				}

				this.executePodInstall().wait();
			}
		}).future<void>()();
	}

	public beforePrepareAllPlugins(): IFuture<void> {
		return Future.fromResult();
	}

	private getAllLibsForPluginWithFileExtension(pluginData: IPluginData, fileExtension: string): IFuture<string[]> {
		let filterCallback = (fileName: string, pluginPlatformsFolderPath: string) => path.extname(fileName) === fileExtension;
		return this.getAllNativeLibrariesForPlugin(pluginData, IOSProjectService.IOS_PLATFORM_NAME, filterCallback);
	};

	private buildPathToXcodeProjectFile(version: string): string {
		return path.join(this.$npmInstallationManager.getCachedPackagePath(this.platformData.frameworkPackageName, version), constants.PROJECT_FRAMEWORK_FOLDER_NAME, `${IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER}.xcodeproj`, "project.pbxproj");
	}

	private validateFramework(libraryPath: string): IFuture<void> {
		return (() => {
			let infoPlistPath = path.join(libraryPath, "Info.plist");
			if (!this.$fs.exists(infoPlistPath).wait()) {
				this.$errors.failWithoutHelp("The bundle at %s does not contain an Info.plist file.", libraryPath);
			}

			let packageType = this.$childProcess.spawnFromEvent("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundlePackageType", infoPlistPath], "close").wait().stdout.trim();
			if (packageType !== "FMWK") {
				this.$errors.failWithoutHelp("The bundle at %s does not appear to be a dynamic framework.", libraryPath);
			}
		}).future<void>()();
	}

	private validateStaticLibrary(libraryPath: string): IFuture<void> {
		return (() => {
			if (path.extname(libraryPath) !== ".a") {
				this.$errors.failWithoutHelp(`The bundle at ${libraryPath} does not contain a valid static library in the '.a' file format.`);
			}

			let expectedArchs = ["armv7", "arm64", "i386"];
			let archsInTheFatFile = this.$childProcess.exec("lipo -i " + libraryPath).wait();

			expectedArchs.forEach(expectedArch => {
				if (archsInTheFatFile.indexOf(expectedArch) < 0) {
					this.$errors.failWithoutHelp(`The static library at ${libraryPath} is not built for one or more of the following required architectures: ${expectedArchs.join(", ")}. The static library must be built for all required architectures.`);
				}
			});
		}).future<void>()();
	}

	private replaceFileContent(file: string): IFuture<void> {
		return (() => {
			let fileContent = this.$fs.readText(file).wait();
			let replacedContent = helpers.stringReplaceAll(fileContent, IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER, this.$projectData.projectName);
			this.$fs.writeFile(file, replacedContent).wait();
		}).future<void>()();
	}

	private replaceFileName(fileNamePart: string, fileRootLocation: string): IFuture<void> {
		return (() => {
			let oldFileName = IOSProjectService.IOS_PROJECT_NAME_PLACEHOLDER + fileNamePart;
			let newFileName = this.$projectData.projectName + fileNamePart;

			this.$fs.rename(path.join(fileRootLocation, oldFileName), path.join(fileRootLocation, newFileName)).wait();
		}).future<void>()();
	}

	private executePodInstall(): IFuture<any> {
		return (() => {
			// Check availability
			try {
				this.$childProcess.exec("gem which cocoapods").wait();
				this.$childProcess.exec("gem which xcodeproj").wait();
			} catch (e) {
				this.$errors.failWithoutHelp("CocoaPods or ruby gem 'xcodeproj' is not installed. Run `sudo gem install cocoapods` and try again.");
			}

			this.$xcprojService.verifyXcproj(true).wait();

			this.$logger.info("Installing pods...");
			let podTool = this.$config.USE_POD_SANDBOX ? "sandbox-pod" : "pod";
			let childProcess = this.$childProcess.spawnFromEvent(podTool, ["install"], "close", { cwd: this.platformData.projectRoot, stdio: ['pipe', process.stdout, 'pipe'] }).wait();
			if (childProcess.stderr) {
				let warnings = childProcess.stderr.match(/(\u001b\[(?:\d*;){0,5}\d*m[\s\S]+?\u001b\[(?:\d*;){0,5}\d*m)|(\[!\].*?\n)|(.*?warning.*)/gi);
				_.each(warnings, (warning: string) => {
					this.$logger.warnWithLabel(warning.replace("\n", ""));
				});

				let errors = childProcess.stderr;
				_.each(warnings, warning => {
					errors = errors.replace(warning, "");
				});

				if (errors.trim()) {
					this.$errors.failWithoutHelp(`Pod install command failed. Error output: ${errors}`);
				}
			}

			if (this.$xcprojService.getXcprojInfo().wait().shouldUseXcproj) {
				this.$childProcess.spawnFromEvent("xcproj", ["--project", this.xcodeprojPath, "touch"], "close").wait();
			}

			return childProcess;
		}).future<any>()();
	}

	private prepareFrameworks(pluginPlatformsFolderPath: string, pluginData: IPluginData): IFuture<void> {
		return (() => {
			_.each(this.getAllLibsForPluginWithFileExtension(pluginData, ".framework").wait(), fileName => this.addDynamicFramework(path.join(pluginPlatformsFolderPath, fileName)).wait());
		}).future<void>()();
	}

	private prepareStaticLibs(pluginPlatformsFolderPath: string, pluginData: IPluginData): IFuture<void> {
		return (() => {
			_.each(this.getAllLibsForPluginWithFileExtension(pluginData, ".a").wait(), fileName => this.addStaticLibrary(path.join(pluginPlatformsFolderPath, fileName)).wait());
		}).future<void>()();
	}

	private prepareCocoapods(pluginPlatformsFolderPath: string, opts?: any): IFuture<void> {
		return (() => {
			let pluginPodFilePath = path.join(pluginPlatformsFolderPath, "Podfile");
			if (this.$fs.exists(pluginPodFilePath).wait()) {
				let pluginPodFileContent = this.$fs.readText(pluginPodFilePath).wait(),
					pluginPodFilePreparedContent = this.buildPodfileContent(pluginPodFilePath, pluginPodFileContent),
					projectPodFileContent = this.$fs.exists(this.projectPodFilePath).wait() ? this.$fs.readText(this.projectPodFilePath).wait() : "";

				if (!~projectPodFileContent.indexOf(pluginPodFilePreparedContent)) {
					let podFileHeader = this.$cocoapodsService.getPodfileHeader(this.$projectData.projectName),
						podFileFooter = this.$cocoapodsService.getPodfileFooter();

					if (_.startsWith(projectPodFileContent, podFileHeader)) {
						projectPodFileContent = projectPodFileContent.substr(podFileHeader.length);
					}

					if (_.endsWith(projectPodFileContent, podFileFooter)) {
						projectPodFileContent = projectPodFileContent.substr(0, projectPodFileContent.length - podFileFooter.length);
					}

					let contentToWrite = `${podFileHeader}${projectPodFileContent}${pluginPodFilePreparedContent}${podFileFooter}`;
					this.$fs.writeFile(this.projectPodFilePath, contentToWrite).wait();

					let project = this.createPbxProj();
					this.ensureIos8DeploymentTarget(project);
					this.savePbxProj(project).wait();
				}
			}

			if (opts && opts.executePodInstall && this.$fs.exists(pluginPodFilePath).wait()) {
				this.executePodInstall().wait();
			}
		}).future<void>()();
	}

	private removeFrameworks(pluginPlatformsFolderPath: string, pluginData: IPluginData): IFuture<void> {
		return (() => {
			let project = this.createPbxProj();
			_.each(this.getAllLibsForPluginWithFileExtension(pluginData, ".framework").wait(), fileName => {
				let relativeFrameworkPath = this.getLibSubpathRelativeToProjectPath(fileName);
				project.removeFramework(relativeFrameworkPath, { customFramework: true, embed: true });
			});

			this.savePbxProj(project).wait();
		}).future<void>()();
	}

	private removeStaticLibs(pluginPlatformsFolderPath: string, pluginData: IPluginData): IFuture<void> {
		return (() => {
			let project = this.createPbxProj();

			_.each(this.getAllLibsForPluginWithFileExtension(pluginData, ".a").wait(), fileName => {
				let staticLibPath = path.join(pluginPlatformsFolderPath, fileName);
				let relativeStaticLibPath = this.getLibSubpathRelativeToProjectPath(path.basename(staticLibPath));
				project.removeFramework(relativeStaticLibPath);

				let headersSubpath = path.join("include", path.basename(staticLibPath, ".a"));
				let relativeHeaderSearchPath = path.join(this.getLibSubpathRelativeToProjectPath(headersSubpath));
				project.removeFromHeaderSearchPaths({ relativePath: relativeHeaderSearchPath });
			});

			this.savePbxProj(project).wait();
		}).future<void>()();
	}

	private removeCocoapods(pluginPlatformsFolderPath: string): IFuture<void> {
		return (() => {
			let pluginPodFilePath = path.join(pluginPlatformsFolderPath, "Podfile");
			if (this.$fs.exists(pluginPodFilePath).wait() && this.$fs.exists(this.projectPodFilePath).wait()) {
				let pluginPodFileContent = this.$fs.readText(pluginPodFilePath).wait();
				let projectPodFileContent = this.$fs.readText(this.projectPodFilePath).wait();
				let contentToRemove = this.buildPodfileContent(pluginPodFilePath, pluginPodFileContent);
				projectPodFileContent = helpers.stringReplaceAll(projectPodFileContent, contentToRemove, "");
				if (projectPodFileContent.trim() === `use_frameworks!${os.EOL}${os.EOL}target "${this.$projectData.projectName}" do${os.EOL}${os.EOL}end`) {
					this.$fs.deleteFile(this.projectPodFilePath).wait();
				} else {
					this.$fs.writeFile(this.projectPodFilePath, projectPodFileContent).wait();
				}

			}
		}).future<void>()();
	}

	private buildPodfileContent(pluginPodFilePath: string, pluginPodFileContent: string): string {
		return `# Begin Podfile - ${pluginPodFilePath} ${os.EOL} ${pluginPodFileContent} ${os.EOL} # End Podfile ${os.EOL}`;
	}

	private generateMobulemap(headersFolderPath: string, libraryName: string): void {
		let headersFilter = (fileName: string, containingFolderPath: string) => (path.extname(fileName) === ".h" && this.$fs.getFsStats(path.join(containingFolderPath, fileName)).wait().isFile());
		let headersFolderContents = this.$fs.readDirectory(headersFolderPath).wait();
		let headers = _(headersFolderContents).filter(item => headersFilter(item, headersFolderPath)).value();

		if (!headers.length) {
			this.$fs.deleteFile(path.join(headersFolderPath, "module.modulemap")).wait();
			return;
		}

		headers = _.map(headers, value => `header "${value}"`);

		let modulemap = `module ${libraryName} { explicit module ${libraryName} { ${headers.join(" ")} } }`;
		this.$fs.writeFile(path.join(headersFolderPath, "module.modulemap"), modulemap).wait();
	}

	private mergeXcconfigFiles(pluginFile: string, projectFile: string): IFuture<void> {
		return (() => {
			if (!this.$fs.exists(projectFile).wait()) {
				this.$fs.writeFile(projectFile, "").wait();
			}

			this.checkIfXcodeprojIsRequired().wait();
			let escapedProjectFile = projectFile.replace(/'/g, "\\'"),
				escapedPluginFile = pluginFile.replace(/'/g, "\\'"),
				mergeScript = `require 'xcodeproj'; Xcodeproj::Config.new('${escapedProjectFile}').merge(Xcodeproj::Config.new('${escapedPluginFile}')).save_as(Pathname.new('${escapedProjectFile}'))`;
			this.$childProcess.exec(`ruby -e "${mergeScript}"`).wait();
		}).future<void>()();
	}

	private mergeProjectXcconfigFiles(): IFuture<void> {
		return (() => {
			this.$fs.deleteFile(this.pluginsDebugXcconfigFilePath).wait();
			this.$fs.deleteFile(this.pluginsReleaseXcconfigFilePath).wait();

			let allPlugins: IPluginData[] = (<IPluginsService>this.$injector.resolve("pluginsService")).getAllInstalledPlugins().wait();
			for (let plugin of allPlugins) {
				let pluginPlatformsFolderPath = plugin.pluginPlatformsFolderPath(IOSProjectService.IOS_PLATFORM_NAME);
				let pluginXcconfigFilePath = path.join(pluginPlatformsFolderPath, "build.xcconfig");
				if (this.$fs.exists(pluginXcconfigFilePath).wait()) {
					this.mergeXcconfigFiles(pluginXcconfigFilePath, this.pluginsDebugXcconfigFilePath).wait();
					this.mergeXcconfigFiles(pluginXcconfigFilePath, this.pluginsReleaseXcconfigFilePath).wait();
				}
			}

			let appResourcesXcconfigPath = path.join(this.$projectData.projectDir, constants.APP_FOLDER_NAME, constants.APP_RESOURCES_FOLDER_NAME, this.platformData.normalizedPlatformName, "build.xcconfig");
			if (this.$fs.exists(appResourcesXcconfigPath).wait()) {
				this.mergeXcconfigFiles(appResourcesXcconfigPath, this.pluginsDebugXcconfigFilePath).wait();
				this.mergeXcconfigFiles(appResourcesXcconfigPath, this.pluginsReleaseXcconfigFilePath).wait();
			}

			let podFilesRootDirName = path.join("Pods", "Target Support Files", `Pods-${this.$projectData.projectName}`);
			let podFolder = path.join(this.platformData.projectRoot, podFilesRootDirName);
			if (this.$fs.exists(podFolder).wait()) {
				this.mergeXcconfigFiles(path.join(this.platformData.projectRoot, podFilesRootDirName, `Pods-${this.$projectData.projectName}.debug.xcconfig`), this.pluginsDebugXcconfigFilePath).wait();
				this.mergeXcconfigFiles(path.join(this.platformData.projectRoot, podFilesRootDirName, `Pods-${this.$projectData.projectName}.release.xcconfig`), this.pluginsReleaseXcconfigFilePath).wait();
			}
		}).future<void>()();
	}

	private checkIfXcodeprojIsRequired(): IFuture<void> {
		return (() => {
			let xcprojInfo = this.$xcprojService.getXcprojInfo().wait();
			if (xcprojInfo.shouldUseXcproj && !xcprojInfo.xcprojAvailable) {
				let errorMessage = `You are using CocoaPods version ${xcprojInfo.cocoapodVer} which does not support Xcode ${xcprojInfo.xcodeVersion.major}.${xcprojInfo.xcodeVersion.minor} yet.${EOL}${EOL}You can update your cocoapods by running $sudo gem install cocoapods from a terminal.${EOL}${EOL}In order for the NativeScript CLI to be able to work correctly with this setup you need to install xcproj command line tool and add it to your PATH. Xcproj can be installed with homebrew by running $ brew install xcproj from the terminal`;

				this.$errors.failWithoutHelp(errorMessage);

				return true;
			}
		}).future<void>()();
	}

	private getXcodeVersion(): string {
		let xcodeBuildVersion = "";

		try {
			xcodeBuildVersion = this.$childProcess.exec("xcodebuild -version | head -n 1 | sed -e 's/Xcode //'").wait();
		} catch (error) {
			this.$errors.fail("xcodebuild execution failed. Make sure that you have latest Xcode and tools installed.");
		}

		let splitedXcodeBuildVersion = xcodeBuildVersion.split(".");
		if (splitedXcodeBuildVersion.length === 3) {
			xcodeBuildVersion = `${splitedXcodeBuildVersion[0]}.${splitedXcodeBuildVersion[1]}`;
		}

		return xcodeBuildVersion;
	}

	private getDevelopmentTeams(): Array<{id:string, name: string}> {
		let dir = path.join(process.env.HOME, "Library/MobileDevice/Provisioning Profiles/");
		let files = this.$fs.readDirectory(dir).wait();
		let teamIds: any = {};
		for (let file of files) {
			let filePath = path.join(dir, file);
			let data = this.$fs.readText(filePath, "utf8").wait();
			let teamId = this.getProvisioningProfileValue("TeamIdentifier", data);
			let teamName = this.getProvisioningProfileValue("TeamName", data);
			if (teamId) {
				teamIds[teamId] = teamName;
			}
		}
		let teamIdsArray = new Array<{id:string, name: string}>();
		for (let teamId in teamIds) {
			teamIdsArray.push({ id:teamId, name:teamIds[teamId] });
		}
		return teamIdsArray;
	}

	private getProvisioningProfileValue(name: string, text: string): string {
		let findStr = "<key>"+name+"</key>";
		let index = text.indexOf(findStr);
		if (index > 0) {
			index = text.indexOf("<string>", index+findStr.length);
			if (index > 0) {
				index += "<string>".length;
				let endIndex = text.indexOf("</string>", index);
				let result = text.substring(index, endIndex);
				return result;
			}
		}
		return null;
	}

	private readTeamId(): string {
		let xcconfigFile = path.join(this.$projectData.appResourcesDirectoryPath, this.platformData.normalizedPlatformName, "build.xcconfig");
		if (this.$fs.exists(xcconfigFile).wait()) {
			let text = this.$fs.readText(xcconfigFile).wait();
			let teamId: string;
			text.split(/\r?\n/).forEach((line) => {
				line = line.replace(/\/(\/)[^\n]*$/, "");
				if (line.indexOf("DEVELOPMENT_TEAM") >= 0) {
					teamId = line.split("=")[1].trim();
					if (teamId[teamId.length-1] === ';') {
						teamId = teamId.slice(0, -1);
					}
				}
			});
			if (teamId) {
				return teamId;
			}
		}
		let fileName = path.join(this.platformData.projectRoot, "teamid");
		if (this.$fs.exists(fileName).wait()) {
			return this.$fs.readText(fileName).wait();
		}
		return null;
	}

	private getDevelopmentTeam(): string {
		let teamId: string;
		if (this.$options.teamId) {
			teamId = this.$options.teamId;
		} else {
			teamId = this.readTeamId();
		}
		if (!teamId) {
			let teams = this.getDevelopmentTeams();
			this.$logger.warn("Xcode 8 requires a team id to be specified when building for device.");
			this.$logger.warn("You can specify the team id by setting the DEVELOPMENT_TEAM setting in build.xcconfig file located in App_Resources folder of your app, or by using the --teamId option when calling run, debug or livesync commnads.");
			if (teams.length === 1) {
				teamId = teams[0].id;
				this.$logger.warn("Found and using the following development team installed on your system: " + teams[0].name + " (" + teams[0].id + ")");
			} else if (teams.length > 0) {
				let choices: string[] = [];
				for (let team of teams) {
					choices.push(team.name + " (" + team.id + ")");
				}
				let choice = this.$prompter.promptForChoice('Found multiple development teams, select one:', choices).wait();
				teamId = teams[choices.indexOf(choice)].id;

				let choicesPersist = [
					"Yes, set the DEVELOPMENT_TEAM setting in build.xcconfig file.",
					"Yes, persist the team id in platforms folder.",
					"No, don't persist this setting."
				];
				let choicePersist = this.$prompter.promptForChoice("Do you want to make teamId: "+teamId+" a persistent choice for your app?", choicesPersist).wait();
				switch (choicesPersist.indexOf(choicePersist)) {
					case 0:
						let xcconfigFile = path.join(this.$projectData.appResourcesDirectoryPath, this.platformData.normalizedPlatformName, "build.xcconfig");
						this.$fs.appendFile(xcconfigFile, "\nDEVELOPMENT_TEAM = " + teamId + "\n").wait();
						break;
					case 1:
						this.$fs.writeFile(path.join(this.platformData.projectRoot, "teamid"), teamId);
						break;
					default:
						break;
				}
			}
		}
		return teamId;
	}
}

$injector.register("iOSProjectService", IOSProjectService);
