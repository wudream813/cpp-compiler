#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <limits.h>

#include <cctype>
#include <string>
#include <algorithm>

bool isConsoleFile(const char* path) {
    if (!path || !*path) return false;
    std::string p(path);
    std::string lower = p;
    for (char &c : lower) c = std::tolower((unsigned char)c);
    if (lower == "con" || lower == "conin$" || lower == "conout$" || lower == "nul" || lower == "aux" || lower == "prn") return true;
    if (lower == "/dev/stdin" || lower == "/dev/stdout" || lower == "/dev/stderr" || lower == "/dev/tty" || lower == "/dev/console") return true;
    if (lower.rfind("/dev/pts/", 0) == 0) return true;
    size_t sep = p.find_last_of("/\\");
    std::string base = (sep == std::string::npos) ? p : p.substr(sep + 1);
    size_t dot = base.find('.');
    std::string nameNoExt = (dot == std::string::npos) ? base : base.substr(0, dot);
    std::string nameLower = nameNoExt;
    for (char &c : nameLower) c = std::tolower((unsigned char)c);
    const std::string reserved[] = {"con","conin$","conout$","nul","aux","prn","com1","com2","com3","com4","com5","com6","com7","com8","com9","lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"};
    for (auto &r : reserved) if (nameLower == r) return true;
    std::string baseLower = base;
    for (char &c : baseLower) c = std::tolower((unsigned char)c);
    for (auto &r : reserved) if (baseLower == r) return true;
    return false;
}

bool shouldExclude(const char* name, const char* exclude1, const char* exclude2, const char* exclude3, const char* exclude4) {
    if (!name) return false;
    const char* base = strrchr(name, '/');
    if (base) base++; else base = name;
    const char* b2 = strrchr(name, '\\');
    if (b2 && (!base || b2 > base)) base = b2 + 1;
    const char* exs[] = {exclude1, exclude2, exclude3, exclude4};
    for (int i=0;i<4;i++) if (exs[i] && exs[i][0]) {
        const char* eb = strrchr(exs[i], '/');
        if (eb) eb++; else eb = exs[i];
        const char* eb2 = strrchr(exs[i], '\\');
        if (eb2 && (!eb || eb2 > eb)) eb = eb2 + 1;
        if (strcmp(base, eb)==0 || strcmp(name, exs[i])==0) return true;
    }
    return false;
}

void copyFileContent(const char* src, const char* dst) {
    int in = open(src, O_RDONLY);
    if (in < 0) return;
    int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) { close(in); return; }
    char buf[8192];
    ssize_t n;
    while ((n = read(in, buf, sizeof(buf))) > 0) write(out, buf, n);
    close(in); close(out);
}

// 镜像到临时目录的规模上限：WorkDir 里若有 .git / node_modules / 大素材，
// 每次运行全量拷贝会非常慢，超限时停止拷贝并提示一次。
#define DREAM_MIRROR_MAX_ENTRIES 20000
#define DREAM_MIRROR_MAX_BYTES (256LL * 1024 * 1024)
static int g_mirrorEntries = 0;
static long long g_mirrorBytes = 0;
static bool g_mirrorWarned = false;

static bool isHugeVcsDir(const char* name) {
    return !strcmp(name, ".git") || !strcmp(name, ".hg") || !strcmp(name, ".svn") || !strcmp(name, "node_modules");
}

static bool mirrorBudgetExceeded() {
    if (g_mirrorEntries <= DREAM_MIRROR_MAX_ENTRIES && g_mirrorBytes <= DREAM_MIRROR_MAX_BYTES) return false;
    if (!g_mirrorWarned) {
        g_mirrorWarned = true;
        printf("提示：工作目录镜像超过上限（20000 项 / 256 MB），剩余文件未拷贝；需要完整目录请打开「工作目录直跑」。\n");
    }
    return true;
}

// 相对路径按工作目录拼接；本身就是绝对路径则原样使用（否则会拼成 workDir/home/xxx 这种鬼路径）
static void joinWorkDir(char* out, size_t sz, const char* workDir, const char* rel) {
    if (rel && rel[0] == '/') {
        snprintf(out, sz, "%s", rel);
    } else {
        snprintf(out, sz, "%s/%s", (workDir && *workDir) ? workDir : ".", rel ? rel : "");
    }
}

void mirrorWorkDirRecursive(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    if (mirrorBudgetExceeded()) return;
    DIR* d = opendir(workDir);
    if (!d) return;
    struct dirent* e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        if (shouldExclude(e->d_name, ex1, ex2, ex3, ex4)) continue;
        char src[PATH_MAX], dst[PATH_MAX];
        snprintf(src, sizeof(src), "%s/%s", workDir, e->d_name);
        snprintf(dst, sizeof(dst), "%s/%s", tempDir, e->d_name);
        struct stat st;
        if (lstat(src, &st) != 0) continue;
        if (S_ISLNK(st.st_mode)) {
            char linkTarget[PATH_MAX];
            ssize_t len = readlink(src, linkTarget, sizeof(linkTarget)-1);
            if (len > 0) {
                linkTarget[len]=0;
                symlink(linkTarget, dst);
            }
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            if (isHugeVcsDir(e->d_name)) continue;
            mkdir(dst, 0755);
            mirrorWorkDirRecursive(src, dst, ex1, ex2, ex3, ex4);
        } else if (S_ISREG(st.st_mode)) {
            if (mirrorBudgetExceeded()) continue;
            copyFileContent(src, dst);
            g_mirrorEntries++;
            g_mirrorBytes += (long long)st.st_size;
        }
    }
    closedir(d);
}

void mirrorWorkDir(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    if (!workDir || !*workDir) return;
    struct stat st;
    if (stat(workDir, &st)!=0 || !S_ISDIR(st.st_mode)) return;
    char realWork[PATH_MAX], realTemp[PATH_MAX];
    if (realpath(workDir, realWork) && realpath(tempDir, realTemp)) {
        if (strncmp(realWork, realTemp, strlen(realTemp))==0 || strncmp(realTemp, realWork, strlen(realWork))==0) return;
    }
    mirrorWorkDirRecursive(workDir, tempDir, ex1, ex2, ex3, ex4);
}

void ensureParentDirPosix(const char* filePath) {
    char tmp[PATH_MAX];
    strncpy(tmp, filePath, sizeof(tmp)-1);
    tmp[sizeof(tmp)-1]=0;
    char* slash = strrchr(tmp, '/');
    if (!slash) return;
    *slash = 0;
    char cur[PATH_MAX] = "";
    if (tmp[0] == '/') { strcpy(cur, "/"); }
    char* p = strtok(tmp[0]=='/' ? tmp+1 : tmp, "/");
    char built[PATH_MAX] = "";
    if (tmp[0]=='/') strcpy(built, "/");
    while (p) {
        if (strlen(built) > 1 || built[0]!='/') {
            if (strlen(built)>0 && built[strlen(built)-1]!='/') strcat(built, "/");
        }
        strcat(built, p);
        mkdir(built, 0755);
        p = strtok(nullptr, "/");
    }
}

bool fileExistsPosix(const char* path) {
    struct stat st;
    return stat(path, &st)==0;
}

#include <signal.h>

// ---- 直跑模式会临时把用户的输入/输出文件改名成 <file>.dream_bak_<pid>，
// ---- 一旦被 Ctrl+C / 崩溃打断就来不及还原，用户数据会从原路径“消失”。
// ---- 这里登记所有备份，并在异常退出前还原。
#define DREAM_MAX_BACKUPS 4
static char g_bakOrig[DREAM_MAX_BACKUPS][PATH_MAX];
static char g_bakNew[DREAM_MAX_BACKUPS][PATH_MAX];
static int g_bakCount = 0;

static void rememberBackup(const char* orig, const char* bak) {
    if (g_bakCount >= DREAM_MAX_BACKUPS) return;
    snprintf(g_bakOrig[g_bakCount], PATH_MAX, "%s", orig);
    snprintf(g_bakNew[g_bakCount], PATH_MAX, "%s", bak);
    g_bakCount++;
}

static void restoreBackupsOnExit() {
    for (int i = 0; i < g_bakCount; i++) {
        if (!g_bakOrig[i][0]) continue;
        if (access(g_bakNew[i], F_OK) == 0) {   // 备份还在 → 正常流程没还原
            unlink(g_bakOrig[i]);
            rename(g_bakNew[i], g_bakOrig[i]);
        }
        g_bakOrig[i][0] = 0;
    }
}

static void onFatalSignal(int sig) {
    restoreBackupsOnExit();
    signal(sig, SIG_DFL);
    raise(sig);
}

void backupFilePosix(const char* path, char* backupPath, size_t sz) {
    backupPath[0]=0;
    if (!fileExistsPosix(path)) return;
    snprintf(backupPath, sz, "%s.dream_bak_%d", path, (int)getpid());
    rename(path, backupPath);
    rememberBackup(path, backupPath);
}

void restoreFilePosix(const char* path, const char* backupPath) {
    if (backupPath && *backupPath) {
        unlink(path);
        rename(backupPath, path);
    } else {
        unlink(path);
    }
}



void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (d) {
        struct dirent* p;
        while ((p = readdir(d))) {
            if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
            char buf[PATH_MAX];
            snprintf(buf, PATH_MAX, "%s/%s", path, p->d_name);
            struct stat statbuf;
            if (!lstat(buf, &statbuf)) {
                if (S_ISLNK(statbuf.st_mode)) unlink(buf);
                else if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
                else unlink(buf);
            }
        }
        closedir(d);
    }
    rmdir(path);
}

bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld_%d_%d", base, (long long)time(NULL), (int)getpid(), rand() % 10000);
    // 父目录 dream-cpp-compiler 不一定存在（临时目录被清理后就会没有），
    // 不先建出来的话下面的 mkdir 必然失败，helper 会静默返回 -1。
    ensureParentDirPosix(tempDir);
    return mkdir(tempDir, 0777) == 0 || errno == EEXIST;
}

bool writeStdinToFile(const char* filePath) {
    int fd = open(filePath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return false;
    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
        write(fd, buffer, bytes);
    }
    close(fd);
    return true;
}

int runExe(const char* exePath, const char* workingDir) {
    pid_t pid = fork();
    if (pid == 0) {
        if (workingDir) chdir(workingDir);
        char* args[] = { (char*)exePath, NULL };
        execvp(exePath, args);
        _exit(127);
    }
    int status;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

int main(int argc, char* argv[]) {
    atexit(restoreBackupsOnExit);
    signal(SIGINT, onFatalSignal);
    signal(SIGTERM, onFatalSignal);
    signal(SIGHUP, onFatalSignal);
    const char* workDir = "";
    bool workDirDirect = false;
    if (argc == 6) { workDir = argv[4]; workDirDirect = argv[5][0]=='1'; }
    else if (argc == 5) workDir = argv[4];
    else if (argc != 4) {
        printf("用法：UnFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }

    bool inputIsCon = isConsoleFile(argv[2]);
    bool outputIsCon = isConsoleFile(argv[3]);
    if (inputIsCon && outputIsCon) {
        return runExe(argv[1], nullptr);
    }
    if (workDirDirect && workDir && *workDir) {
        char directInput[PATH_MAX] = {0}, directOutput[PATH_MAX] = {0};
        char backupInput[PATH_MAX] = {0}, backupOutput[PATH_MAX] = {0};
        if (!inputIsCon) {
            joinWorkDir(directInput, sizeof(directInput), workDir, argv[2]);
            ensureParentDirPosix(directInput);
            backupFilePosix(directInput, backupInput, sizeof(backupInput));
            if (!writeStdinToFile(directInput)) {
                if (backupInput[0]) rename(backupInput, directInput);
                return -1;
            }
        }
        if (!outputIsCon) {
            joinWorkDir(directOutput, sizeof(directOutput), workDir, argv[3]);
            ensureParentDirPosix(directOutput);
            backupFilePosix(directOutput, backupOutput, sizeof(backupOutput));
        }
        int ret = runExe(argv[1], workDir);
        if (!outputIsCon) {
            int fd = open(directOutput, O_RDONLY);
            if (fd < 0) {
                printf("错误：无法打开输出文件");
            } else {
                char buffer[4096];
                ssize_t bytes;
                while ((bytes = read(fd, buffer, sizeof(buffer))) > 0) {
                    write(STDOUT_FILENO, buffer, bytes);
                }
                close(fd);
            }
            if (backupOutput[0]) {
                unlink(directOutput);
                rename(backupOutput, directOutput);
            } else {
                unlink(directOutput);
            }
        }
        if (!inputIsCon) {
            if (backupInput[0]) {
                unlink(directInput);
                rename(backupInput, directInput);
            } else {
                unlink(directInput);
            }
        }
        return ret;
    }
    char tempDir[PATH_MAX], tempInput[PATH_MAX] = {0}, tempOutput[PATH_MAX] = {0};
    bool needTemp = !inputIsCon || !outputIsCon;
    if (needTemp) {
        if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("错误：无法创建临时目录，请检查 TMPDIR 权限\n");
        return -1;
    }
        if (!inputIsCon) snprintf(tempInput, PATH_MAX, "%s/%s", tempDir, argv[2]);
        if (!outputIsCon) snprintf(tempOutput, PATH_MAX, "%s/%s", tempDir, argv[3]);
    } else {
        tempDir[0] = 0;
    }
    if (needTemp && workDir && *workDir) {
        mirrorWorkDir(workDir, tempDir, argv[2], argv[3], nullptr, nullptr);
    }
    if (!inputIsCon) {
        if (!writeStdinToFile(tempInput)) {
            if (needTemp) removeDir(tempDir);
            return -1;
        }
    }
    int ret = runExe(argv[1], needTemp ? tempDir : nullptr);
    if (!outputIsCon) {
        int fd = open(tempOutput, O_RDONLY);
        if (fd < 0) {
            printf("错误：无法打开输出文件");
        } else {
            char buffer[4096];
            ssize_t bytes;
            while ((bytes = read(fd, buffer, sizeof(buffer))) > 0) {
                write(STDOUT_FILENO, buffer, bytes);
            }
            close(fd);
        }
    }
    if (needTemp) removeDir(tempDir);
    return ret;
}
