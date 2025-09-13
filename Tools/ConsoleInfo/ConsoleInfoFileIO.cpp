#include <Windows.h>
#include <Psapi.h>
#include <stdio.h>
#include <conio.h>
#include <string.h>

#pragma comment(lib, "psapi.lib")

// �������������þ���̳���
void SetHandleInheritance(HANDLE hHandle, bool inherit) {
    SetHandleInformation(hHandle, HANDLE_FLAG_INHERIT, inherit ? HANDLE_FLAG_INHERIT : 0);
}

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("�÷���ConsoleInfoFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }

    CHAR Command[MAX_PATH];
    strcpy_s(Command, argv[1]);
    SetConsoleTitleA(Command);
    
    // �������ļ�
    HANDLE hInput = CreateFileA(
        argv[2],
        GENERIC_READ,
        FILE_SHARE_READ,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );

    if (hInput == INVALID_HANDLE_VALUE) {
        printf("�������ļ�ʧ��: %s��������: %d\n", argv[2], GetLastError());
        return -1;
    }

    // ������ļ�
    HANDLE hOutput = CreateFileA(
        argv[3],
        GENERIC_WRITE,
        0,
        NULL,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );

    if (hOutput == INVALID_HANDLE_VALUE) {
        printf("������ļ�ʧ��: %s��������: %d\n", argv[3], GetLastError());
        CloseHandle(hInput);
        return -1;
    }

    // ���þ���̳���
    SetHandleInheritance(hInput, true);
    SetHandleInheritance(hOutput, true);
    
    // ��ȷʹ��ANSI�汾�Ľṹ��
    STARTUPINFOA StartupInfo;  // ����ʹ��STARTUPINFOA����STARTUPINFO
    PROCESS_INFORMATION ProcessInfo;
    PROCESS_MEMORY_COUNTERS_EX pmc;
    memset(&ProcessInfo, 0, sizeof(ProcessInfo));
    memset(&StartupInfo, 0, sizeof(StartupInfo));
    StartupInfo.cb = sizeof(STARTUPINFOA);  // ��ȷָ��ANSI�汾��С
    StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    StartupInfo.wShowWindow = SW_HIDE;
    StartupInfo.hStdInput = hInput;
    StartupInfo.hStdOutput = hOutput;
    StartupInfo.hStdError = hOutput;
    
    // ��¼��ʼʱ��
    LARGE_INTEGER StartingTime, EndingTime, Frequency;
    QueryPerformanceFrequency(&Frequency);
    QueryPerformanceCounter(&StartingTime);

    // �������̣�ʹ��ANSI�汾��CreateProcessA��
    if (!CreateProcessA(
        NULL, 
        Command, 
        NULL, 
        NULL, 
        TRUE, 
        CREATE_NO_WINDOW, 
        NULL, 
        NULL, 
        &StartupInfo,  // ��������ƥ����
        &ProcessInfo
    )) {
        printf("��������ʧ��: %s��������: %d\n", Command, GetLastError());
        CloseHandle(hInput);
        CloseHandle(hOutput);
        return -1;
    }

    // �ȴ����̽���
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);
    
    // ��ȡ�����ͳ����Ϣ
    GetProcessMemoryInfo(ProcessInfo.hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));
    
    FILETIME creationTime, exitTime, kernelTime, userTime;
    GetProcessTimes(ProcessInfo.hProcess, &creationTime, &exitTime, &kernelTime, &userTime);
    
    QueryPerformanceCounter(&EndingTime);
    LONGLONG executionTime = (EndingTime.QuadPart - StartingTime.QuadPart) * 1000000 / Frequency.QuadPart;
    
    DWORD returnValue;
    GetExitCodeProcess(ProcessInfo.hProcess, &returnValue);
    
    ULARGE_INTEGER kernelTimeUL, userTimeUL;
    kernelTimeUL.LowPart = kernelTime.dwLowDateTime;
    kernelTimeUL.HighPart = kernelTime.dwHighDateTime;
    userTimeUL.LowPart = userTime.dwLowDateTime;
    userTimeUL.HighPart = userTime.dwHighDateTime;
    
    ULONGLONG totalKernelTime = kernelTimeUL.QuadPart / 10;
    ULONGLONG totalUserTime = userTimeUL.QuadPart / 10;
    
    // ������Դ
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);
    CloseHandle(hInput);
    CloseHandle(hOutput);
    
    // ������
    printf("\n-----------------------------------------------");
    printf("\n��ִ��ʱ�䣺%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n�ڴ�ʹ�ã�%lu KB", (unsigned long)(pmc.PeakWorkingSetSize >> 10));
    printf("\nCPU�ں�ʱ�䣺%.3f ��", totalKernelTime / 1000000.0);
    printf("\nCPU�û�ʱ�䣺%.3f ��", totalUserTime / 1000000.0);
    printf("\n��CPUʱ�䣺%.3f ��", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n���򷵻�ֵ��%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");
    return 0;
}
    