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

void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (d) {
        struct dirent* p;
        while ((p = readdir(d))) {
            if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
            char buf[PATH_MAX];
            snprintf(buf, PATH_MAX, "%s/%s", path, p->d_name);
            struct stat statbuf;
            if (!stat(buf, &statbuf)) {
                if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
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
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld", base, (long long)time(NULL));
    return mkdir(tempDir, 0777) == 0;
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
    if (argc != 4) {
        printf("用法：UnFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }

    char tempDir[PATH_MAX], tempInput[PATH_MAX], tempOutput[PATH_MAX];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) return -1;

    snprintf(tempInput, PATH_MAX, "%s/%s", tempDir, argv[2]);
    snprintf(tempOutput, PATH_MAX, "%s/%s", tempDir, argv[3]);

    if (!writeStdinToFile(tempInput)) {
        removeDir(tempDir);
        return -1;
    }

    int ret = runExe(argv[1], tempDir);

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

    removeDir(tempDir);
    return ret;
}
